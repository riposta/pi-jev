/**
 * tools/sweep.ts — offline threshold sweep over a saved `evaluate.ts --json`
 * report. Recomputes router decisions from the recorded answers, so tuning
 * costs nothing in API calls.
 *
 * Usage:
 *   node --experimental-strip-types tools/sweep.ts /tmp/jev-eval.json
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { deepMerge, defaultConfig } from "../src/config.ts";
import { decideRouter, type RouterAnswers } from "../src/modules/router.ts";
import type { Config, TierName } from "../src/types.ts";

interface Item {
  prompt: string;
  expected: TierName;
  got: TierName;
  answers: unknown;
}

interface Combo {
  confidenceFloor: number;
  reasoningBumpScore: number;
  reasoningDropScore: number;
  reasoningConfidenceFloor: number;
}

export interface SweepResult extends Combo {
  accuracy: number;
  correct: number;
  total: number;
  confusion: Record<string, number>;
}

export function sweepRouterItems(items: readonly Item[], base: Config): SweepResult[] {
  const grids = {
    confidenceFloor: [0, 0.2, 0.3, 0.4, 0.5, 0.6],
    reasoningBumpScore: [1.5, 1.6, 1.7, 1.8, 1.85, 1.9, 2.0],
    reasoningDropScore: [0, 0.2, 0.3, 0.4],
    reasoningConfidenceFloor: [0, 0.1, 0.2, 0.3],
  };
  const results: SweepResult[] = [];
  for (const confidenceFloor of grids.confidenceFloor) {
    for (const reasoningConfidenceFloor of grids.reasoningConfidenceFloor) {
      for (const reasoningBumpScore of grids.reasoningBumpScore) {
        for (const reasoningDropScore of grids.reasoningDropScore) {
          const config = deepMerge(base, {
            modules: { router: { confidenceFloor, reasoningConfidenceFloor, reasoningBumpScore, reasoningDropScore } },
          });
          const confusion: Record<string, number> = {};
          let correct = 0;
          let total = 0;
          for (const item of items) {
            if (!item.answers) continue;
            const decision = decideRouter(item.answers as RouterAnswers, config);
            total += 1;
            if (decision.tier === item.expected) correct += 1;
            confusion[`${item.expected}->${decision.tier}`] = (confusion[`${item.expected}->${decision.tier}`] ?? 0) + 1;
          }
          results.push({
            confidenceFloor,
            reasoningConfidenceFloor,
            reasoningBumpScore,
            reasoningDropScore,
            accuracy: correct / total,
            correct,
            total,
            confusion,
          });
        }
      }
    }
  }
  return results.sort((a, b) => b.accuracy - a.accuracy);
}

function main(argv: string[]): void {
  const path = argv.find((arg) => !arg.startsWith("--"));
  if (!path) {
    console.error("usage: sweep <evaluate-report.json>");
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(path, "utf8")) as { router?: { items?: Item[] } };
  const items = report.router?.items ?? [];
  const results = sweepRouterItems(items, defaultConfig());
  console.log(`items: ${items.length}`);
  const showAll = argv.includes("--all");
  const rows = showAll ? results : results.slice(0, 10);
  for (const row of rows) {
    console.log(
      `acc=${(row.accuracy * 100).toFixed(1)}% (${row.correct}/${row.total})  ` +
        `taskFloor=${row.confidenceFloor} reasonFloor=${row.reasoningConfidenceFloor} bump=${row.reasoningBumpScore} drop=${row.reasoningDropScore}  ` +
        JSON.stringify(row.confusion),
    );
  }
  const best = results[0];
  if (best) {
    console.log(
      `\nbest config snippet:\n  "confidenceFloor": ${best.confidenceFloor},\n  "reasoningConfidenceFloor": ${best.reasoningConfidenceFloor},\n  "reasoningBumpScore": ${best.reasoningBumpScore},\n  "reasoningDropScore": ${best.reasoningDropScore}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
