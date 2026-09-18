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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WATCHDOG_QUESTIONS } from "../questions.ts";
import type { Answers, Config, Deps, WatchdogDecision } from "../types.ts";
import { summariseTurn, type SummarisedTurn } from "../messages.ts";
import { formatStatus } from "../telemetry.ts";

export type WatchdogAnswers = Answers<typeof WATCHDOG_QUESTIONS>;

const MAX_TURNS_IN_STATE = 6;

export interface WatchdogState {
  user_request: string;
  recent_turns: SummarisedTurn[];
  turn_index: number;
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

export function verifyMessage(): string {
  return (
    "Jev: completion was claimed without verification. Before stopping, run the tests, read the changed file back, or check the build."
  );
}

export function register(pi: ExtensionAPI, deps: Deps): void {
  let userRequest = "";
  let turnIndex = 0;
  const recentTurns: SummarisedTurn[] = [];

  pi.on("before_agent_start", (event) => {
    userRequest = event.prompt;
  });

  pi.on("turn_end", async (event, ctx) => {
    turnIndex = event.turnIndex + 1;
    const summary = summariseTurn(event.message, event.toolResults);
    recentTurns.push(summary);
    while (recentTurns.length > MAX_TURNS_IN_STATE) recentTurns.shift();

    if (!deps.config.modules.watchdog.enabled || !deps.state.layerEnabled) return;
    const cfg = deps.config.modules.watchdog;
    if (turnIndex < cfg.minTurns) return;
    if (turnIndex % cfg.everyNTurns !== 0) return;

    const state: WatchdogState = {
      user_request: userRequest,
      recent_turns: [...recentTurns],
      turn_index: turnIndex,
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

    const decision = evaluateWatchdog(result.answers, deps.config);
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
      detail: { progress: decision.progress, turn: turnIndex },
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
        { customType: "jev-watchdog", content: verifyMessage(), display: true },
        { deliverAs: "followUp" },
      );
    }
  });
}
