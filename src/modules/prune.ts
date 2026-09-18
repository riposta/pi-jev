/**
 * Module: prune.
 *
 * Hook: `tool_result`, sharing one request with shield (initial_plan.md §5.4). Replaces a
 * low-relevance result with a short summary and a pointer to the full output on
 * disk.
 *
 * Pruning is off by default even outside shadow mode. It is the module most
 * likely to remove something the agent needed, and its benefit is measured in
 * tokens rather than correctness (initial_plan.md §10.4).
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answers, Config, PruneDecision } from "../types.ts";
import { FAILURE_TYPE_QUESTION, PRUNE_QUESTIONS } from "../questions.ts";
import { firstLine } from "../messages.ts";

export type PruneAnswers = Answers<typeof PRUNE_QUESTIONS & typeof FAILURE_TYPE_QUESTION>;

export function evaluatePrune(
  answers: PruneAnswers,
  config: Config,
  totalLines: number,
): PruneDecision {
  const cfg = config.modules.prune;
  const relevance = answers.relevance.score;
  if (!cfg.enabled) return { prune: false, relevance };
  if (totalLines < cfg.minLines) return { prune: false, relevance };
  return { prune: relevance < cfg.relevanceThreshold, relevance };
}

export interface PrunedOutput {
  path: string;
  notice: string;
}

/** Writes the full output to a temp file and returns the pointer notice. */
export function pruneOutput(raw: string, toolCallId: string, dir: string = tmpdir()): PrunedOutput {
  const path = join(dir, `pi-jev-${toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
  writeFileSync(path, raw);
  const summary = firstLine(raw, 200);
  const notice = summary
    ? `Jev: output pruned as low-relevance. Full output at ${path}\n${summary}`
    : `Jev: output pruned as low-relevance. Full output at ${path}`;
  return { path, notice };
}

/** The injected suggestion for a detected failure type (initial_plan.md §10.5). */
export function failureSuggestion(
  answers: Answers<typeof FAILURE_TYPE_QUESTION>,
): string | null {
  const choice = answers.failure_type.choice;
  if (choice === "flaky") return "Jev: this looks flaky. Retry once before investigating.";
  if (choice === "env_problem")
    return "Jev: this looks environmental. Check dependencies, versions, paths and permissions before changing code.";
  return null;
}
