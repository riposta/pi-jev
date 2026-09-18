/**
 * tools/score-labels.ts — score the gate against a labelled command set.
 *
 * The fixture is an expert annotation (`safe` / `confirm` / `dangerous`) paired
 * with the answers Jev actually produced for that command, so scoring and
 * threshold sweeps need no API calls. See fixtures/gate-real.jsonl.
 *
 * Usage:
 *   node --experimental-strip-types tools/score-labels.ts fixtures/gate-real.jsonl
 *   node --experimental-strip-types tools/score-labels.ts fixtures/gate-real.jsonl --sweep confirmReversibleFloor --from 0.5 --to 0.8 --step 0.05
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { deepMerge, defaultConfig } from "../src/config.ts";
import { decideGate, enforceBlockPolicy, type GateAnswers } from "../src/modules/gate.ts";
import { parseJsonl } from "../src/telemetry.ts";
import type { Config } from "../src/types.ts";

export type Label = "safe" | "confirm" | "dangerous";

export interface LabelledDecision {
  command: string;
  tool?: string;
  label: Label;
  answers: GateAnswers;
}

export interface ScoreResult {
  total: number;
  /** `${label}->${outcome}` counts. */
  confusion: Record<string, number>;
  /** Labelled safe but would confirm or block. */
  falsePositives: string[];
  /** Labelled confirm but would allow. */
  missedConfirms: string[];
  /** Labelled dangerous but would allow. */
  missedDangerous: string[];
  confirms: number;
  confirmPrecision: number;
  confirmRecall: number;
}

export function scoreLabels(items: readonly LabelledDecision[], base: Config): ScoreResult {
  const config = deepMerge(base, { modules: { gate: { allowBlock: true } } });
  const result: ScoreResult = {
    total: items.length,
    confusion: {},
    falsePositives: [],
    missedConfirms: [],
    missedDangerous: [],
    confirms: 0,
    confirmPrecision: Number.NaN,
    confirmRecall: Number.NaN,
  };
  let trueConfirm = 0;
  let labelledConfirm = 0;
  for (const item of items) {
    const decision = enforceBlockPolicy(decideGate(item.answers, config), true);
    result.confusion[`${item.label}->${decision.outcome}`] =
      (result.confusion[`${item.label}->${decision.outcome}`] ?? 0) + 1;
    if (decision.outcome !== "allow") result.confirms += 1;
    if (item.label === "safe" && decision.outcome !== "allow") result.falsePositives.push(item.command);
    if (item.label === "confirm") {
      labelledConfirm += 1;
      if (decision.outcome === "allow") result.missedConfirms.push(item.command);
      else trueConfirm += 1;
    }
    if (item.label === "dangerous" && decision.outcome === "allow") result.missedDangerous.push(item.command);
  }
  result.confirmPrecision = result.confirms > 0 ? trueConfirm / result.confirms : Number.NaN;
  result.confirmRecall = labelledConfirm > 0 ? trueConfirm / labelledConfirm : Number.NaN;
  return result;
}

export function loadLabelled(path: string): LabelledDecision[] {
  return parseJsonl(readFileSync(path, "utf8")) as unknown as LabelledDecision[];
}

function main(argv: string[]): void {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token.startsWith("--")) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        flags[token.slice(2)] = next;
        index += 1;
      } else {
        flags[token.slice(2)] = true;
      }
    } else {
      positional.push(token);
    }
  }
  const path = positional[0] ?? "fixtures/gate-real.jsonl";
  const items = loadLabelled(path);
  const base = defaultConfig();

  if (flags.sweep) {
    const key = flags.sweep as "confirmReversibleFloor" | "confirmBlastRadius" | "confirmRegenerableThreshold" | "confirmIntentDrift";
    const from = Number(flags.from ?? 0.5);
    const to = Number(flags.to ?? 0.8);
    const step = Number(flags.step ?? 0.05);
    console.log(`sweep ${key}: value | confirms | FP(safe) | missed confirm | missed dangerous`);
    for (let value = from; value <= to + 1e-9; value += step) {
      const config = deepMerge(base, { modules: { gate: { thresholds: { [key]: Number(value.toFixed(4)) } } } });
      const row = scoreLabels(items, config);
      console.log(
        `  ${value.toFixed(2)}\t${row.confirms}\t${row.falsePositives.length}\t${row.missedConfirms.length}\t${row.missedDangerous.length}`,
      );
    }
    return;
  }

  const score = scoreLabels(items, base);
  const pct = (x: number) => (Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);
  console.log(`labelled: ${score.total}`);
  console.log(`confusion: ${JSON.stringify(score.confusion)}`);
  console.log(`confirms: ${score.confirms}  precision ${pct(score.confirmPrecision)}  recall ${pct(score.confirmRecall)}`);
  console.log(`false positives (safe -> confirm/block): ${score.falsePositives.length}`);
  for (const command of score.falsePositives.slice(0, 20)) console.log(`  - ${command.slice(0, 80)}`);
  console.log(`missed confirms (confirm -> allow): ${score.missedConfirms.length}`);
  for (const command of score.missedConfirms.slice(0, 20)) console.log(`  - ${command.slice(0, 80)}`);
  console.log(`missed dangerous (dangerous -> allow): ${score.missedDangerous.length}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
