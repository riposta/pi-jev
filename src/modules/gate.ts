/**
 * Module: gate.
 *
 * Hook: `tool_call`. Frequency: high — the only module where volume matters.
 * Risk: high — this one can block work.
 *
 * Including the original user request in the state is the design choice that
 * distinguishes this from every regex-based gate: it makes drift detectable
 * (SDD 9.2, 9.6).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { effectiveSkipCommands } from "../config.ts";
import { GATE_QUESTIONS } from "../questions.ts";
import type { Answers, Config, Deps, GateDecision, GateOutcome } from "../types.ts";
import { formatStatus } from "../telemetry.ts";

export type GateAnswers = Answers<typeof GATE_QUESTIONS>;

/* -------------------------------------------------------------------------- */
/* Pre-flight skips (SDD 6.4)                                                 */
/* -------------------------------------------------------------------------- */

const SHELL_OPERATORS = /[|&;<>`$()\n]/;

/** True when the command is exactly a read-only prefix and contains no chaining or redirects. */
export function isSkippedCommand(command: string, allowlist: readonly string[]): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (SHELL_OPERATORS.test(trimmed)) return false;
  return allowlist.some((prefix) => {
    if (trimmed === prefix) return true;
    return trimmed.startsWith(`${prefix} `) || trimmed.startsWith(`${prefix}\t`);
  });
}

export function isSkippedTool(tool: string, skipTools: readonly string[]): boolean {
  return skipTools.includes(tool);
}

/* -------------------------------------------------------------------------- */
/* Command normalisation for the on-disk cache                                */
/* -------------------------------------------------------------------------- */

/**
 * Paths and numeric literals are masked so that `git log -5` and `git log -10`
 * share a cache entry. Whitespace is collapsed. This is only a cache key; the
 * gate still classifies the unmodified command.
 */
export function normaliseCommand(command: string): string {
  return command
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\?)+/g, "<path>")
    .replace(/(?:\/(?:Users|home|private|var|tmp|opt|srv|etc|Volumes)\/[^\s"'`),;:]*)/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export function describeToolInput(tool: string, input: Record<string, unknown>): string {
  if (typeof input.command === "string") return input.command;
  if (typeof input.path === "string") {
    const extra = JSON.stringify(input).slice(0, 2000);
    return `${tool} ${input.path}\n${extra}`;
  }
  return `${tool} ${JSON.stringify(input).slice(0, 2000)}`;
}

export interface GateState {
  tool: string;
  command: string;
  cwd_basename: string;
  user_request: string;
  recent_commands: string[];
}

/* -------------------------------------------------------------------------- */
/* Decision (SDD 9.4)                                                         */
/* -------------------------------------------------------------------------- */

export function decideGate(answers: GateAnswers, config: Config): GateDecision {
  const t = config.modules.gate.thresholds;
  const blast = answers.blast_radius.score;
  const reversible = answers.reversible.noul;
  const confidence = answers.blast_radius.confidence;
  const intent = answers.matches_intent.noul;
  const secrets = answers.touches_secrets.noul;
  const exfil = answers.exfiltrates.noul;
  const unverified = answers.unverified_code.noul;

  const numbers = {
    blast_radius: blast,
    reversible,
    confidence,
    matches_intent: intent,
    touches_secrets: secrets,
    exfiltrates: exfil,
    unverified_code: unverified,
  };

  if (unverified > t.blockUnverifiedCode) {
    return { outcome: "block", rule: 1, reason: `unverified external code (${unverified.toFixed(2)})`, numbers };
  }
  if (blast >= t.blockBlastRadius && reversible < t.blockReversible) {
    return {
      outcome: "block",
      rule: 2,
      reason: `blast radius ${blast.toFixed(1)}/3 and irreversible (${reversible.toFixed(2)})`,
      numbers,
    };
  }
  if (intent < t.confirmIntentDrift && blast >= t.confirmDriftBlastRadius) {
    return { outcome: "confirm", rule: 3, reason: `outside the original request (${intent.toFixed(2)})`, numbers };
  }
  if (blast >= t.confirmBlastRadius) {
    return { outcome: "confirm", rule: 4, reason: `blast radius ${blast.toFixed(1)}/3`, numbers };
  }
  // Added after the first calibration run (SDD 13.3): a command that is not
  // cleanly reversible and reaches beyond the files being worked on is worth a
  // look even below the shared-resource line.
  if (blast >= t.confirmIrreversibleBlastRadius && reversible < t.confirmReversibleFloor) {
    return {
      outcome: "confirm",
      rule: 4,
      reason: `not cleanly reversible (${reversible.toFixed(2)}) at blast radius ${blast.toFixed(1)}/3`,
      numbers,
    };
  }
  if (secrets > t.confirmSecrets || exfil > t.confirmExfiltration) {
    const which = secrets > t.confirmSecrets ? "touches secrets" : "sends data out";
    const value = secrets > t.confirmSecrets ? secrets : exfil;
    return { outcome: "confirm", rule: 5, reason: `${which} (${value.toFixed(2)})`, numbers };
  }
  if (confidence < t.confidenceFloor) {
    return { outcome: "confirm", rule: 6, reason: `unsure about blast radius (confidence ${confidence.toFixed(2)})`, numbers };
  }
  return { outcome: "allow", rule: 7, reason: "within thresholds", numbers };
}

/**
 * Rows 1 and 2 are disabled until `gate.allowBlock` is set after shadow data
 * exists. A disabled block degrades to confirm rather than allow, so nothing is
 * lost from the user's view.
 */
export function enforceBlockPolicy(decision: GateDecision, allowBlock: boolean): GateDecision {
  if (decision.outcome === "block" && !allowBlock) {
    return { ...decision, outcome: "confirm", reason: `${decision.reason} [block disabled → confirm]` };
  }
  return decision;
}

/* -------------------------------------------------------------------------- */
/* Hook                                                                       */
/* -------------------------------------------------------------------------- */

export function register(pi: ExtensionAPI, deps: Deps): void {
  let userRequest = "";
  const recentCommands: string[] = [];

  pi.on("before_agent_start", (event) => {
    userRequest = event.prompt;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!deps.config.modules.gate.enabled || !deps.state.layerEnabled) return;
    const tool = event.toolName;
    const config = deps.config.modules.gate;
    if (isSkippedTool(tool, config.skipTools)) return;

    const input = event.input as Record<string, unknown>;
    const command = describeToolInput(tool, input);
    if (typeof input.command === "string" && isSkippedCommand(input.command, effectiveSkipCommands(config))) {
      return;
    }

    const state: GateState = {
      tool,
      command,
      cwd_basename: basename(ctx.cwd),
      user_request: userRequest,
      recent_commands: [...recentCommands],
    };
    recentCommands.push(command);
    while (recentCommands.length > 3) recentCommands.shift();

    const result = await deps.ask("gate", state, GATE_QUESTIONS, {
      signal: ctx.signal,
      cacheKey: normaliseCommand(command),
    });

    if (!result) {
      return failOpen(deps, ctx, tool, command);
    }

    const computed = enforceBlockPolicy(decideGate(result.answers, deps.config), config.allowBlock);
    const shadow = deps.state.shadow.gate;
    let enforced: GateOutcome = shadow ? "allow" : computed.outcome;
    let userChoice: "allow" | "deny" | "unknown" | undefined;
    let blockReason: string | undefined;

    if (!shadow && computed.outcome === "confirm") {
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm("Jev: confirm", confirmMessage(computed, command));
        userChoice = ok ? "allow" : "deny";
        enforced = ok ? "allow" : "block";
        if (!ok) blockReason = `blocked by user: ${computed.reason}`;
      } else {
        // print/json mode: no prompts (SDD 14, mode behaviour).
        userChoice = "unknown";
        if (config.withoutUi === "deny") {
          enforced = "block";
          blockReason = `no UI to confirm: ${computed.reason}`;
        } else {
          enforced = "allow";
        }
      }
    } else if (!shadow && computed.outcome === "block") {
      blockReason = computed.reason;
    }

    const record = {
      hook: "gate" as const,
      questionsVersion: "",
      stateHash: result.meta.stateHash,
      state: result.meta.redactedState,
      tool,
      answers: result.answers,
      decision: enforced,
      shadow,
      wouldHaveBeen: computed.outcome,
      userChoice,
      latencyMs: result.meta.latencyMs,
      cached: result.meta.cached,
      usage: result.meta.usage,
      reason: computed.reason,
      detail: {
        rule: computed.rule,
        numbers: computed.numbers,
        command: command.slice(0, 500),
      },
    };
    deps.log(record);
    deps.appendEntry(record);
    deps.state.last.gate = record;
    deps.status(formatStatus(deps.state, deps.config));

    if (blockReason) return { block: true, reason: `Jev: ${blockReason}` };
    return;
  });
}

function failOpen(deps: Deps, ctx: ExtensionContext, tool: string, command: string): { block: true; reason: string } | void {
  const config = deps.config.modules.gate;
  const shadow = deps.state.shadow.gate;
  const deny = !shadow && config.onFailure === "deny";
  deps.log({
    hook: "gate",
    questionsVersion: "",
    stateHash: "",
    tool,
    decision: deny ? "block" : "allow",
    shadow,
    wouldHaveBeen: "fail_open",
    reason: "classification unavailable",
    detail: { command: command.slice(0, 500) },
  });
  deps.status(formatStatus(deps.state, deps.config));
  if (deny) return { block: true, reason: "Jev: classification unavailable and gate.onFailure=deny" };
  return;
}

/** The auditable prompt: the reason and the driving number (SDD 9.5). */
export function confirmMessage(decision: GateDecision, command: string): string {
  return `${decision.reason}\n  ${command.split("\n")[0]}\nAllow?`;
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
