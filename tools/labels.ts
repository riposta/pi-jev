/**
 * tools/labels.ts — read the gate's `userChoice` labels out of a log.
 *
 * Every confirm answer the user gives is a supervised label (initial_plan.md §13.3). This
 * summarises them: overall allow/deny, deny rate per decision-table rule, and
 * the commands the user denied. With `--sweep <threshold>` it also replays the
 * recorded answers at each threshold and reports the deny rate among the
 * confirms that threshold would have produced.
 *
 * Usage:
 *   node --experimental-strip-types tools/labels.ts <file-or-dir>
 *   node --experimental-strip-types tools/labels.ts <file-or-dir> --sweep confirmBlastRadius --from 1 --to 3 --step 0.25
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultConfig } from "../src/config.ts";
import { parseJsonl } from "../src/telemetry.ts";
import type { TelemetryRecord } from "../src/types.ts";
import { sweepGate, type GateThresholdKey } from "./calibrate.ts";

export interface RuleLabels {
  allow: number;
  deny: number;
  denyRate: number;
}

export interface LabelSummary {
  labelled: number;
  allow: number;
  deny: number;
  unknown: number;
  /** deny / (allow + deny); NaN when there are no labels. */
  denyRate: number;
  byRule: Record<string, RuleLabels>;
  deniedCommands: string[];
  allowedCommands: string[];
}

export function summariseLabels(records: readonly TelemetryRecord[]): LabelSummary {
  const summary: LabelSummary = {
    labelled: 0,
    allow: 0,
    deny: 0,
    unknown: 0,
    denyRate: Number.NaN,
    byRule: {},
    deniedCommands: [],
    allowedCommands: [],
  };
  for (const record of records) {
    if (record.hook !== "gate" || !record.userChoice) continue;
    const command = String((record.detail as { command?: string } | undefined)?.command ?? "").slice(0, 80);
    if (record.userChoice === "unknown") {
      summary.unknown += 1;
      continue;
    }
    summary.labelled += 1;
    const detail = record.detail as { rule?: number; branch?: string } | undefined;
    const rule = `r${detail?.rule ?? "?"}${detail?.branch ? `:${detail.branch}` : ""}`;
    const bucket = (summary.byRule[rule] ??= { allow: 0, deny: 0, denyRate: Number.NaN });
    if (record.userChoice === "deny") {
      summary.deny += 1;
      bucket.deny += 1;
      summary.deniedCommands.push(command);
    } else {
      summary.allow += 1;
      bucket.allow += 1;
      summary.allowedCommands.push(command);
    }
  }
  const total = summary.allow + summary.deny;
  summary.denyRate = total > 0 ? summary.deny / total : Number.NaN;
  for (const bucket of Object.values(summary.byRule)) {
    const t = bucket.allow + bucket.deny;
    bucket.denyRate = t > 0 ? bucket.deny / t : Number.NaN;
  }
  return summary;
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
  const path = positional[0];
  if (!path) {
    console.error("usage: labels <file-or-dir> [--sweep confirmBlastRadius] [--from 1] [--to 3] [--step 0.25]");
    process.exit(1);
  }
  const records = loadRecords(path);
  const summary = summariseLabels(records);
  console.log(`labels: ${summary.labelled} (allow ${summary.allow} / deny ${summary.deny} / unknown ${summary.unknown})`);
  console.log(`deny rate: ${Number.isNaN(summary.denyRate) ? "n/a" : `${(summary.denyRate * 100).toFixed(1)}%`}`);
  for (const [rule, bucket] of Object.entries(summary.byRule)) {
    const rate = Number.isNaN(bucket.denyRate) ? "n/a" : `${(bucket.denyRate * 100).toFixed(0)}%`;
    console.log(`  ${rule}: allow ${bucket.allow} / deny ${bucket.deny} (${rate})`);
  }
  if (summary.deniedCommands.length > 0) {
    console.log("denied:");
    for (const command of summary.deniedCommands.slice(0, 20)) console.log(`  - ${command}`);
  }

  if (flags.sweep) {
    const question = flags.sweep as GateThresholdKey;
    const from = Number(flags.from ?? 1);
    const to = Number(flags.to ?? 3);
    const step = Number(flags.step ?? 0.25);
    const values: number[] = [];
    for (let value = from; value <= to + 1e-9; value += step) values.push(Number(value.toFixed(4)));
    console.log(`\nsweep ${question}:`);
    for (const row of sweepGate(records, defaultConfig(), question, values)) {
      const rate = Number.isNaN(row.denyRate) ? "n/a" : `${(row.denyRate * 100).toFixed(0)}%`;
      console.log(`  ${row.value}\tmix=${JSON.stringify(row.mix)}\tdenied=${row.denied}/${row.labelled} (${rate})`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
