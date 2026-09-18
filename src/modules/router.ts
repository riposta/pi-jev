/**
 * Module: router.
 *
 * Hook: `before_agent_start`. Frequency: once per user prompt. Risk: low — a
 * wrong decision yields a worse answer, not a damaged repository. This is why
 * it ships first.
 *
 * P4: uncertainty routes toward safety. Low confidence bumps the tier up; it
 * never downgrades. P5: any failure means Pi behaves as if we were not here.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { ROUTER_QUESTIONS, ROUTER_QUESTIONS_CORE, withModelChoice } from "../questions.ts";
import type {
  Answers,
  ChoiceAnswer,
  Config,
  Deps,
  RouterDecision,
  TierName,
  ThinkingLevel,
} from "../types.ts";
import { formatStatus } from "../telemetry.ts";
import { messageText } from "../messages.ts";

export type RouterAnswers = Answers<typeof ROUTER_QUESTIONS>;

/** The subset `decideRouter` actually reads; keeps the decision independent of speculative questions. */
export type RouterDecisionInput = Pick<
  RouterAnswers,
  "task_type" | "reasoning_needed" | "is_underspecified" | "needs_write_tools" | "touches_sensitive"
>;

/**
 * Loadout for work that is unlikely to write. It removes the direct mutators
 * (`write`, `edit`) but keeps `bash`: shell is how read-only tasks actually get
 * done (`printenv`, `git log`, a test run), and every shell command is still
 * classified by the gate. Stripping `bash` made "show me the env" impossible.
 */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "bash", "ls", "grep", "find"];

/** Appended to the system prompt when the request is underspecified. */
export const CLARIFY_DIRECTIVE =
  "Before making any edit, check whether the request is missing a goal, constraint, or target file. " +
  "If it is, ask one concise clarifying question and wait for the answer.";

const BASE_TIER: Record<string, TierName> = {
  trivial_edit: "cheap",
  question: "cheap",
  localized_fix: "standard",
  investigation: "standard",
  refactor: "standard",
  feature: "standard",
  architecture: "strong",
  other: "standard",
};

const ORDER: TierName[] = ["cheap", "standard", "strong"];

function bump(tier: TierName, delta: number): TierName {
  const index = ORDER.indexOf(tier);
  const next = Math.min(ORDER.length - 1, Math.max(0, index + delta));
  return ORDER[next] ?? tier;
}

function isAllowed(config: Config, tier: TierName, allowedModels: readonly string[]): boolean {
  const entry = config.modules.router.tiers[tier];
  return (
    allowedModels.includes(entry.model) || allowedModels.includes(`${entry.provider}/${entry.model}`)
  );
}

/**
 * The residency allowlist narrows the tier; it never widens it. Returns the
 * strongest allowed tier at or below the requested one.
 */
export function restrictToAllowed(
  tier: TierName,
  config: Config,
  allowedModels: readonly string[],
): { tier: TierName; restricted: boolean } {
  if (allowedModels.length === 0) return { tier, restricted: false };
  const from = ORDER.indexOf(tier);
  for (let index = from; index >= 0; index -= 1) {
    const candidate = ORDER[index] as TierName;
    if (isAllowed(config, candidate, allowedModels)) {
      return { tier: candidate, restricted: candidate !== tier };
    }
  }
  // Nothing at or below the requested tier is allowed. Do not silently upgrade
  // into a stronger model either; leave the tier and let the caller decide.
  return { tier, restricted: false };
}

/** First thinking band whose upper bound is not exceeded. */
export function thinkingFor(score: number, bands: { max: number; level: ThinkingLevel }[]): ThinkingLevel {
  for (const band of bands) {
    if (score <= band.max) return band.level;
  }
  return bands[bands.length - 1]?.level ?? "off";
}

/** True when a concrete model is inside the residency allowlist. */
export function isAllowedModel(
  model: { provider: string; model: string },
  allowedModels: readonly string[],
): boolean {
  return (
    allowedModels.includes(model.model) || allowedModels.includes(`${model.provider}/${model.model}`)
  );
}

/**
 * Pure decision logic. Tests feed it fixed answers; the hook only supplies
 * state. Every threshold comes from config.
 *
 * `available` is the list Pi actually has, used only to resolve the optional
 * `target_model` answer; when it or the answer is absent, the tier map decides,
 * which is what the offline fixtures and older logs exercise.
 */
export function decideRouter(
  answers: RouterDecisionInput,
  config: Config,
  available: readonly ModelInfo[] = [],
  targetModel?: ChoiceAnswer,
): RouterDecision {
  const router = config.modules.router;
  const taskType = answers.task_type.choice;
  const reasoning = answers.reasoning_needed.score;

  let tier = BASE_TIER[taskType] ?? "standard";
  if (reasoning >= router.reasoningBumpScore) tier = bump(tier, 1);
  else if (reasoning <= router.reasoningDropScore) tier = bump(tier, -1);

  const taskConfidence = answers.task_type.confidence;
  const reasoningConfidence = answers.reasoning_needed.confidence;
  const lowConfidence: string[] = [];
  if (taskConfidence < router.confidenceFloor) {
    tier = bump(tier, 1);
    lowConfidence.push("task_type");
  }
  if (reasoningConfidence < router.reasoningConfidenceFloor) {
    tier = bump(tier, 1);
    lowConfidence.push("reasoning_needed");
  }

  let chosenModel = resolveChosenModel(targetModel, available);

  let restricted = false;
  const sensitive = answers.touches_sensitive.noul;
  if (config.residency.enabled && sensitive > router.sensitiveThreshold) {
    const resolved = restrictToAllowed(tier, config, config.residency.allowedModels);
    tier = resolved.tier;
    restricted = resolved.restricted;
    // A directly chosen model must honour the allowlist too; otherwise drop it
    // and fall back to the restricted tier.
    if (chosenModel && !isAllowedModel(chosenModel, config.residency.allowedModels)) {
      chosenModel = undefined;
    }
  }

  const thinking = thinkingFor(reasoning, router.thinkingBands);

  // Noul has no confidence. The guard is a dead zone around the threshold:
  // "not sure whether write tools are needed" must not strip them.
  const write = answers.needs_write_tools.noul;
  const readOnly = write < router.readOnlyThreshold && write <= 0.35;

  const clarify = answers.is_underspecified.noul > router.clarifyThreshold;

  return {
    tier,
    thinking,
    chosenModel,
    readOnly,
    clarify,
    restricted,
    signals: {
      task_type: taskType,
      reasoning_needed: reasoning,
      task_type_confidence: taskConfidence,
      reasoning_confidence: reasoningConfidence,
      touches_sensitive: sensitive,
      needs_write_tools: write,
      is_underspecified: answers.is_underspecified.noul,
      low_confidence: lowConfidence.join(",") || "none",
      target_model: targetModel?.choice ?? "none",
      chosen_model: chosenModel ? `${chosenModel.provider}/${chosenModel.model}` : "none",
    },
  };
}

/** Exact string form the reviewer can compare against config.tiers. */
export function tierLabel(tier: TierName, config: Config): string {
  const entry = config.modules.router.tiers[tier];
  return `${entry.provider}/${entry.model}`;
}

/* -------------------------------------------------------------------------- */
/* Available models (from Pi)                                                 */
/* -------------------------------------------------------------------------- */

/** The subset of Pi's model record the router needs. Kept Pi-agnostic. */
export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

/**
 * Reads the models Pi can actually use right now (`getAvailable`), so the
 * classifier is offered real choices instead of the config's tier names, which
 * may point at providers this machine does not have. Defensive: a registry
 * without `getAvailable` (older Pi, test fakes) yields an empty list and the
 * router falls back to the tier map.
 */
export function availableModels(ctx: ExtensionContext): ModelInfo[] {
  const registry = ctx.modelRegistry as unknown as {
    getAvailable?: () => Array<{
      provider: unknown;
      id: string;
      name?: string;
      reasoning?: boolean;
      contextWindow?: number;
    }>;
  };
  if (typeof registry?.getAvailable !== "function") return [];
  try {
    return registry.getAvailable().map((model) => ({
      provider: String(model.provider),
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
    }));
  } catch {
    return [];
  }
}

/** A short, reviewable description for the model Choice criteria. */
export function describeModel(model: ModelInfo): string {
  const parts = [`${model.provider}/${model.id}`];
  if (model.name && model.name !== model.id) parts.push(model.name);
  if (model.reasoning) parts.push("extended reasoning");
  if (model.contextWindow) parts.push(`${Math.round(model.contextWindow / 1000)}k context`);
  return parts.join(" — ").slice(0, 200);
}

/**
 * Maps the classifier's `target_model` answer (`m0`, `m1`, …) back to a model
 * Pi reported. Returns undefined for a missing or malformed answer, so the
 * tier fallback applies.
 */
export function resolveChosenModel(
  answer: ChoiceAnswer | undefined,
  available: readonly ModelInfo[],
): { provider: string; model: string } | undefined {
  if (!answer) return undefined;
  const match = /^m(\d+)$/.exec(answer.choice);
  if (!match) return undefined;
  const model = available[Number(match[1])];
  return model ? { provider: model.provider, model: model.id } : undefined;
}

/** The model a tier resolves to in config. */
export function modelForTier(config: Config, tier: TierName): { provider: string; model: string } {
  const entry = config.modules.router.tiers[tier];
  return { provider: entry.provider, model: entry.model };
}

export function register(pi: ExtensionAPI, deps: Deps): void {
  const recentFiles: string[] = [];
  let previousTurn = "";
  let warnedMissingModel = false;
  // The full tool loadout captured before the router ever narrows it, so a
  // later write-capable prompt can restore it. Without this the session stayed
  // read-only after a single read-only classification.
  let allTools: string[] | undefined;

  pi.on("session_start", () => {
    allTools = undefined;
    warnedMissingModel = false;
  });

  pi.on("tool_call", (event) => {
    if (
      isToolCallEventType("write", event) ||
      isToolCallEventType("edit", event) ||
      isToolCallEventType("read", event)
    ) {
      const path = (event.input as { path?: unknown }).path;
      if (typeof path === "string") {
        recentFiles.push(path);
        while (recentFiles.length > 10) recentFiles.shift();
      }
    }
  });

  pi.on("turn_end", (event) => {
    previousTurn = messageText(event.message);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!deps.config.modules.router.enabled || !deps.state.layerEnabled) return;

    // Capture the full loadout before any narrowing happens this session.
    allTools ??= pi.getActiveTools();

    // Pi owns the list of usable models. Send the real list to Jev so the
    // classifier picks a model this machine actually has, instead of a tier
    // name that may point at a provider that is not configured.
    const models = availableModels(ctx);
    const options = models.map((model, index) => ({
      key: `m${index}`,
      description: describeModel(model),
    }));
    const base = deps.config.modules.router.skillRouting ? ROUTER_QUESTIONS : ROUTER_QUESTIONS_CORE;
    const questions = withModelChoice(base, options);

    const state = {
      prompt: event.prompt,
      cwd_basename: basename(ctx.cwd),
      recent_files: [...recentFiles],
      previous_turn: previousTurn,
      available_tiers: ORDER.map((tier) => tierLabel(tier, deps.config)),
      available_models: models.map((model) => `${model.provider}/${model.id}`),
    };

    const result = await deps.ask("router", state, questions, { signal: ctx.signal });
    if (!result) {
      deps.log({
        hook: "router",
        questionsVersion: "",
        stateHash: "",
        decision: "fail_open",
        shadow: deps.state.shadow.router,
        reason: "classification unavailable",
      });
      deps.status(formatStatus(deps.state, deps.config));
      return;
    }

    const targetModel = (result.answers as Record<string, ChoiceAnswer | undefined>).target_model;
    const decision = decideRouter(
      result.answers as unknown as RouterAnswers,
      deps.config,
      models,
      targetModel,
    );
    const shadow = deps.state.shadow.router;
    const record = {
      hook: "router" as const,
      questionsVersion: "",
      stateHash: result.meta.stateHash,
      state: result.meta.redactedState,
      answers: result.answers,
      decision: decision.tier,
      shadow,
      wouldHaveBeen: decision.tier,
      latencyMs: result.meta.latencyMs,
      cached: result.meta.cached,
      usage: result.meta.usage,
      detail: {
        thinking: decision.thinking,
        readOnly: decision.readOnly,
        clarify: decision.clarify,
        restricted: decision.restricted,
        chosenModel: decision.chosenModel
          ? `${decision.chosenModel.provider}/${decision.chosenModel.model}`
          : "tier",
        availableModels: state.available_models,
        signals: decision.signals,
      },
    };
    deps.log(record);
    deps.appendEntry(record);
    deps.state.last.router = record;
    deps.state.activeTier = decision.tier;
    deps.status(formatStatus(deps.state, deps.config));

    if (shadow) return;

    const missing = await applyDecision(pi, ctx, decision, deps.config, allTools);
    if (missing && !warnedMissingModel) {
      warnedMissingModel = true;
      ctx.ui.notify(
        `pi-jev: model ${missing} is not available in Pi; leaving the model unchanged. ` +
          "Configure modules.router.tiers or install the model.",
        "warning",
      );
    }
    if (decision.clarify) {
      return { systemPrompt: `${event.systemPrompt}\n\n${CLARIFY_DIRECTIVE}` };
    }
    return;
  });
}

/**
 * Applies the decision. Returns the `provider/model` label when the resolved
 * model is not in Pi's registry, so the caller can warn once instead of
 * silently keeping the previous model.
 */
export async function applyDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  decision: RouterDecision,
  config: Config,
  fullTools?: readonly string[],
): Promise<string | undefined> {
  const target = decision.chosenModel ?? modelForTier(config, decision.tier);
  const model = ctx.modelRegistry.find(target.provider, target.model);
  let missing: string | undefined;
  if (model) {
    // Skip a redundant switch: re-issuing setModel for the already-active model
    // can restart the turn in Pi and burn an extra model call.
    const current = ctx.model;
    const alreadyActive = current?.provider === model.provider && current?.id === model.id;
    if (!alreadyActive) await pi.setModel(model);
  } else {
    missing = `${target.provider}/${target.model}`;
  }
  pi.setThinkingLevel(decision.thinking);
  // Restore the captured loadout when this prompt is write-capable. Narrowing
  // only (the previous behaviour) left the session stuck on read-only tools.
  if (decision.readOnly) pi.setActiveTools([...READ_ONLY_TOOLS]);
  else if (fullTools && fullTools.length > 0) pi.setActiveTools([...fullTools]);
  return missing;
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
