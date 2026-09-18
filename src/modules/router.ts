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
import { ROUTER_QUESTIONS } from "../questions.ts";
import type { Answers, Config, Deps, RouterDecision, TierName, ThinkingLevel } from "../types.ts";
import { formatStatus } from "../telemetry.ts";
import { messageText } from "../messages.ts";

export type RouterAnswers = Answers<typeof ROUTER_QUESTIONS>;

/** Tools that cannot modify the repository. Used when write work is unlikely. */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "ls", "grep", "find"];

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

/**
 * Pure decision logic. Tests feed it fixed answers; the hook only supplies
 * state. Every threshold comes from config.
 */
export function decideRouter(answers: RouterAnswers, config: Config): RouterDecision {
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

  let restricted = false;
  const sensitive = answers.touches_sensitive.noul;
  if (config.residency.enabled && sensitive > router.sensitiveThreshold) {
    const resolved = restrictToAllowed(tier, config, config.residency.allowedModels);
    tier = resolved.tier;
    restricted = resolved.restricted;
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
    },
  };
}

/** Exact string form the reviewer can compare against config.tiers. */
export function tierLabel(tier: TierName, config: Config): string {
  const entry = config.modules.router.tiers[tier];
  return `${entry.provider}/${entry.model}`;
}

export function register(pi: ExtensionAPI, deps: Deps): void {
  const recentFiles: string[] = [];
  let previousTurn = "";

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
    const state = {
      prompt: event.prompt,
      cwd_basename: basename(ctx.cwd),
      recent_files: [...recentFiles],
      previous_turn: previousTurn,
      available_tiers: ORDER.map((tier) => tierLabel(tier, deps.config)),
    };

    const result = await deps.ask("router", state, ROUTER_QUESTIONS, { signal: ctx.signal });
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

    const decision = decideRouter(result.answers, deps.config);
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
        signals: decision.signals,
      },
    };
    deps.log(record);
    deps.appendEntry(record);
    deps.state.last.router = record;
    deps.state.activeTier = decision.tier;
    deps.status(formatStatus(deps.state, deps.config));

    if (shadow) return;

    await applyDecision(pi, ctx, decision, deps.config);
    if (decision.clarify) {
      return { systemPrompt: `${event.systemPrompt}\n\n${CLARIFY_DIRECTIVE}` };
    }
    return;
  });
}

export async function applyDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  decision: RouterDecision,
  config: Config,
): Promise<void> {
  const tier = config.modules.router.tiers[decision.tier];
  const model = ctx.modelRegistry.find(tier.provider, tier.model);
  if (model) await pi.setModel(model);
  pi.setThinkingLevel(decision.thinking);
  if (decision.readOnly) pi.setActiveTools([...READ_ONLY_TOOLS]);
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
