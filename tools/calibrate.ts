/**
 * tools/calibrate.ts — threshold sweep over a log file (initial_plan.md §13.3).
 *
 * Reads JSONL records (which include full probability vectors by default) and
 * recomputes decisions with one threshold overridden at a time. Where labels
 * exist — the gate's `userChoice` from confirm prompts — it reports the deny
 * rate, which is the friction the threshold causes.
 *
 * Usage:
 *   node --experimental-strip-types tools/calibrate.ts <file-or-dir> \
 *     [--question confirmBlastRadius] [--from 0] [--to 4] [--step 0.25]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deepMerge, defaultConfig } from "../src/config.ts";
import { enforceBlockPolicy, decideGate, type GateAnswers } from "../src/modules/gate.ts";
import { decideRouter, type RouterAnswers } from "../src/modules/router.ts";
import { parseJsonl, summarise } from "../src/telemetry.ts";
import type { Config, TelemetryRecord } from "../src/types.ts";

export type GateThresholdKey =
  | "blockBlastRadius"
  | "blockReversible"
  | "blockUnverifiedCode"
  | "confirmBlastRadius"
  | "confirmIrreversibleBlastRadius"
  | "confirmReversibleFloor"
  | "confirmDriftBlastRadius"
  | "confirmIntentDrift"
  | "confirmSecrets"
  | "confirmExfiltration"
  | "confidenceFloor";

export interface SweepRow {
  question: string;
  value: number;
  mix: Record<string, number>;
  /** Gate only: how often a predicted confirm was denied by the user. */
  labelled: number;
  denied: number;
  denyRate: number;
}

export function sweepGate(
  records: readonly TelemetryRecord[],
  baseConfig: Config,
  question: GateThresholdKey,
  values: readonly number[],
): SweepRow[] {
  return values.map((value) => {
    const config = deepMerge(baseConfig, {
      modules: { gate: { thresholds: { [question]: value } } },
    });
    const mix: Record<string, number> = {};
    let labelled = 0;
    let denied = 0;
    for (const record of records) {
      if (record.hook !== "gate" || !record.answers) continue;
      if (typeof (record.answers as Record<string, unknown>).blast_radius !== "object") continue;
      const decision = enforceBlockPolicy(
        decideGate(record.answers as unknown as GateAnswers, config),
        config.modules.gate.allowBlock,
      );
      mix[decision.outcome] = (mix[decision.outcome] ?? 0) + 1;
      if (decision.outcome === "confirm" && record.userChoice && record.userChoice !== "unknown") {
        labelled += 1;
        if (record.userChoice === "deny") denied += 1;
      }
    }
    return {
      question,
      value,
      mix,
      labelled,
      denied,
      denyRate: labelled > 0 ? denied / labelled : Number.NaN,
    };
  });
}

export function sweepRouter(
  records: readonly TelemetryRecord[],
  baseConfig: Config,
  question: "confidenceFloor" | "clarifyThreshold" | "readOnlyThreshold" | "sensitiveThreshold",
  values: readonly number[],
): SweepRow[] {
  return values.map((value) => {
    const config = deepMerge(baseConfig, { modules: { router: { [question]: value } } });
    const mix: Record<string, number> = {};
    for (const record of records) {
      if (record.hook !== "router" || !record.answers) continue;
      if (typeof (record.answers as Record<string, unknown>).task_type !== "object") continue;
      const decision = decideRouter(record.answers as unknown as RouterAnswers, config);
      mix[decision.tier] = (mix[decision.tier] ?? 0) + 1;
    }
    return { question, value, mix, labelled: 0, denied: 0, denyRate: Number.NaN };
  });
}

export function loadRecords(path: string): TelemetryRecord[] {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const records: TelemetryRecord[] = [];
    for (const file of readdirSync(path).filter((name) => name.endsWith(".jsonl")).sort()) {
      records.push(...parseJsonl(readFileSync(join(path, file), "utf8")));
    }
    return records;
  }
  return parseJsonl(readFileSync(path, "utf8"));
}

function main(argv: string[]): void {
  const { positional, flags } = parseArgs(argv);
  const path = positional[0];
  if (!path || flags.help) {
    console.log(
      "usage: calibrate <file-or-dir> [--question confirmBlastRadius] [--from 0] [--to 4] [--step 0.25] [--router]",
    );
    process.exit(path ? 0 : 1);
  }
  const records = loadRecords(path);
  const config = defaultConfig();
  const question = flags.question ?? "confirmBlastRadius";
  const from = Number(flags.from ?? 0);
  const to = Number(flags.to ?? 4);
  const step = Number(flags.step ?? 0.25);
  const values: number[] = [];
  for (let value = from; value <= to + 1e-9; value += step) values.push(Number(value.toFixed(4)));

  console.log(`records: ${records.length}`);
  console.log(`decision mix: ${JSON.stringify(summarise(records).byDecision)}`);
  const rows = flags.router
    ? sweepRouter(records, config, question as "confidenceFloor", values)
    : sweepGate(records, config, question as GateThresholdKey, values);
  for (const row of rows) {
    const rate = Number.isNaN(row.denyRate) ? "n/a" : `${(row.denyRate * 100).toFixed(1)}%`;
    console.log(
      `${row.question}=${row.value}\tmix=${JSON.stringify(row.mix)}\tdenied=${row.denied}/${row.labelled} (${rate})`,
    );
  }
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
