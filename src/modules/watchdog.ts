/**
 * Module: watchdog.
 *
 * Hook: `turn_end`, every Nth turn after a warm-up. Risk: low — it only injects
 * advice. It never aborts: a false positive would destroy work in progress
 * (initial_plan.md §11.3).
 *
 * An agent looping on the same error is the most expensive failure mode in
 * agentic coding. Catching it at turn 9 instead of turn 30 is worth more than
 * any routing saving.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WATCHDOG_QUESTIONS } from "../questions.ts";
import type { Answers, Config, Deps, WatchdogDecision } from "../types.ts";
import { summariseTurn, messageText, type SummarisedTurn } from "../messages.ts";
import { formatStatus } from "../telemetry.ts";

export type WatchdogAnswers = Answers<typeof WATCHDOG_QUESTIONS>;

const MAX_TURNS_IN_STATE = 6;

/** Commands that produce verification evidence. */
const EVIDENCE_COMMAND =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|verify)|pytest|vitest|jest|tsc|go\s+test|cargo\s+(?:test|check)|make|gradle|mvn|dotnet\s+(?:test|build))\b/;

/** A completion claim, matched in code so it works without a second judgment. */
const DONE_CLAIM = /\b(?:done|finished|complete[d]?|all set|that'?s it|implemented|fixed)\b/i;

export function claimsCompletion(text: string): boolean {
  return DONE_CLAIM.test(text);
}

export function commandIsEvidence(command: string): boolean {
  return EVIDENCE_COMMAND.test(command);
}

const PATH_RE = /(?:^|[\s`'"'(])((?:\.{0,2}\/)?[\w@./-]+\.[A-Za-z0-9]{1,8})(?=[\s`'"').,:;]|$)/g;

/** Candidate file paths referenced in an assistant message. */
export function referencedPaths(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    const path = match[1] as string;
    if (/\.(ts|tsx|js|jsx|py|go|rs|java|json|md|yml|yaml|toml|sh|c|h|cpp|rb)$/.test(path)) out.push(path);
  }
  return [...new Set(out)];
}

/** Paths a message references that do not exist under `cwd`. */
export function missingPaths(text: string, cwd: string): string[] {
  return referencedPaths(text).filter((path) => !existsSync(isAbsolute(path) ? path : join(cwd, path)));
}

function normalizeForRunaway(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase().trim().slice(0, 2_000);
}

/** True when two consecutive assistant replies are near-identical (runaway). */
export function runawayDetected(previous: string, current: string): boolean {
  if (!previous || !current) return false;
  const a = normalizeForRunaway(previous);
  const b = normalizeForRunaway(current);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export interface WatchdogState {
  user_request: string;
  recent_turns: SummarisedTurn[];
  turn_index: number;
  /** Whether a test/build/lint ran, or a written file was read back. */
  evidence: boolean;
}

export function evaluateWatchdog(answers: WatchdogAnswers, config: Config): WatchdogDecision {
  const cfg = config.modules.watchdog;
  const looping = answers.looping.noul > cfg.loopThreshold;
  const falseDone = answers.false_done.noul > cfg.falseDoneThreshold;
  return {
    looping,
    falseDone,
    progress: answers.progress.score,
    inject: looping ? "loop" : falseDone ? "verify" : null,
  };
}

export function loopMessage(): string {
  return (
    "Jev: the recent turns look like a loop (repeating the same failed approach). " +
    "Name what has already been tried, then try a different approach rather than retrying the same step."
  );
}

export function verifyMessage(missing: readonly string[] = []): string {
  const base =
    "Jev: completion was claimed without verification. Before stopping, run the tests, read the changed file back, or check the build.";
  if (missing.length === 0) return base;
  return `${base} These referenced files do not exist: ${missing.join(", ")}.`;
}

export function register(pi: ExtensionAPI, deps: Deps): void {
  let userRequest = "";
  let turnIndex = 0;
  const recentTurns: SummarisedTurn[] = [];
  let commandEvidence = false;
  let lastAssistantText = "";
  const writtenFiles = new Set<string>();
  const readFiles = new Set<string>();

  pi.on("session_start", () => {
    commandEvidence = false;
    lastAssistantText = "";
    writtenFiles.clear();
    readFiles.clear();
  });

  pi.on("before_agent_start", (event) => {
    userRequest = event.prompt;
  });

  pi.on("tool_call", (event) => {
    const input = event.input as Record<string, unknown>;
    if (event.toolName === "bash" && typeof input.command === "string" && commandIsEvidence(input.command)) {
      commandEvidence = true;
    }
    if ((event.toolName === "write" || event.toolName === "edit") && typeof input.path === "string") {
      writtenFiles.add(input.path);
    }
    if (event.toolName === "read" && typeof input.path === "string") {
      readFiles.add(input.path);
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    turnIndex = event.turnIndex + 1;
    const summary = summariseTurn(event.message, event.toolResults);
    recentTurns.push(summary);
    while (recentTurns.length > MAX_TURNS_IN_STATE) recentTurns.shift();

    const text = messageText(event.message);
    const runaway = runawayDetected(lastAssistantText, text);
    lastAssistantText = text;

    if (!deps.config.modules.watchdog.enabled || !deps.state.layerEnabled) return;
    const cfg = deps.config.modules.watchdog;
    if (turnIndex < cfg.minTurns) return;
    if (turnIndex % cfg.everyNTurns !== 0) return;

    const evidence = commandEvidence || [...writtenFiles].some((file) => readFiles.has(file));
    const state: WatchdogState = {
      user_request: userRequest,
      recent_turns: [...recentTurns],
      turn_index: turnIndex,
      evidence,
    };

    const result = await deps.ask("watchdog", state, WATCHDOG_QUESTIONS, { signal: ctx.signal });
    if (!result) {
      deps.log({
        hook: "watchdog",
        questionsVersion: "",
        stateHash: "",
        decision: "fail_open",
        shadow: deps.state.shadow.watchdog,
        reason: "classification unavailable",
      });
      return;
    }

    const missing = missingPaths(text, ctx.cwd);
    const decision = evaluateWatchdog(result.answers, deps.config);
    // A completion claim with no test/build/lint, no read-back, or references
    // to files that do not exist is a false-done regardless of the classifier
    // (TypeSafe: keep judgments code can make exactly out of the model).
    if (cfg.requireEvidence && claimsCompletion(text) && (!evidence || missing.length > 0)) {
      decision.falseDone = true;
    }
    if (runaway) decision.looping = true;
    const shadow = deps.state.shadow.watchdog;
    const record = {
      hook: "watchdog" as const,
      questionsVersion: "",
      stateHash: result.meta.stateHash,
      state: result.meta.redactedState,
      answers: result.answers,
      decision: decision.inject ?? "none",
      shadow,
      wouldHaveBeen: decision.inject ?? "none",
      latencyMs: result.meta.latencyMs,
      cached: result.meta.cached,
      usage: result.meta.usage,
      answeredModel: result.meta.answeredModel,
      detail: { progress: decision.progress, turn: turnIndex, evidence, runaway, missingPaths: missing.slice(0, 5) },
    };
    deps.log(record);
    deps.appendEntry(record);
    deps.state.last.watchdog = record;
    deps.status(formatStatus(deps.state, deps.config));

    if (shadow) return;
    if (decision.looping) {
      pi.sendMessage(
        { customType: "jev-watchdog", content: loopMessage(), display: true },
        { deliverAs: "steer" },
      );
    } else if (decision.falseDone) {
      pi.sendMessage(
        { customType: "jev-watchdog", content: verifyMessage(missing), display: true },
        { deliverAs: "followUp" },
      );
    }
  });
}
