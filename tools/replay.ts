/**
 * tools/replay.ts — re-run recorded states against the current questions
 * (SDD 13.4).
 *
 * Requires `telemetry.logStateContent: true`, which is off by default for good
 * reason. This is how a question edit is evaluated without waiting for new
 * traffic.
 *
 * Usage:
 *   node --experimental-strip-types tools/replay.ts <file-or-dir> [--limit 50]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.ts";
import { createClient } from "../src/client.ts";
import { createRedactor } from "../src/redact.ts";
import {
  GATE_QUESTIONS,
  ROUTER_QUESTIONS,
  SHIELD_PRUNE_QUESTIONS,
  WATCHDOG_QUESTIONS,
} from "../src/questions.ts";
import { parseJsonl } from "../src/telemetry.ts";
import type { Answer, AskFn, HookName, QuestionSet, TelemetryRecord } from "../src/types.ts";

const QUESTIONS_BY_MODULE: Partial<Record<TelemetryRecord["hook"], { hook: HookName; questions: QuestionSet }>> = {
  router: { hook: "router", questions: ROUTER_QUESTIONS },
  gate: { hook: "gate", questions: GATE_QUESTIONS },
  shield: { hook: "shield_prune", questions: SHIELD_PRUNE_QUESTIONS },
  prune: { hook: "shield_prune", questions: SHIELD_PRUNE_QUESTIONS },
  watchdog: { hook: "watchdog", questions: WATCHDOG_QUESTIONS },
};

export interface AnswerDiff {
  id: string;
  before: Answer | undefined;
  after: Answer | undefined;
  changed: boolean;
}

export function diffAnswers(
  before: Record<string, Answer | undefined> | undefined,
  after: Record<string, Answer | undefined> | undefined,
): AnswerDiff[] {
  const ids = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const diffs: AnswerDiff[] = [];
  for (const id of ids) {
    const left = before?.[id];
    const right = after?.[id];
    const changed = JSON.stringify(summarise(left)) !== JSON.stringify(summarise(right));
    diffs.push({ id, before: left, after: right, changed });
  }
  return diffs;
}

function summarise(answer: Answer | undefined): unknown {
  if (!answer) return null;
  if (answer.type === "noul") return { noul: answer.noul };
  if (answer.type === "choice") return { choice: answer.choice, confidence: answer.confidence };
  return { score: answer.score, confidence: answer.confidence };
}

export async function replay(
  records: readonly TelemetryRecord[],
  ask: AskFn,
  limit: number,
): Promise<{ replayed: number; changed: number; details: Array<{ id: string; diffs: AnswerDiff[] }> }> {
  let replayed = 0;
  let changed = 0;
  const details: Array<{ id: string; diffs: AnswerDiff[] }> = [];
  for (const record of records) {
    if (replayed >= limit) break;
    const mapping = QUESTIONS_BY_MODULE[record.hook];
    if (!mapping || record.state === undefined) continue;
    const result = await ask(mapping.hook, record.state, mapping.questions);
    replayed += 1;
    if (!result) continue;
    const diffs = diffAnswers(record.answers, result.answers as Record<string, Answer>);
    if (diffs.some((diff) => diff.changed)) {
      changed += 1;
      details.push({ id: `${record.ts ?? "?"} ${record.hook}`, diffs });
    }
  }
  return { replayed, changed, details };
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

async function main(argv: string[]): Promise<void> {
  const path = argv.find((arg) => !arg.startsWith("--"));
  const limitFlag = argv.indexOf("--limit");
  const limit = limitFlag >= 0 ? Number(argv[limitFlag + 1] ?? "50") : 50;
  if (!path) {
    console.error("usage: replay <file-or-dir> [--limit 50]");
    process.exit(1);
  }
  const config = loadConfig({ cwd: process.cwd(), trusted: true });
  const state = {
    layerEnabled: true,
    shadow: { router: true, gate: true, shield: true, prune: true, watchdog: true },
    clientDisabledReason: null,
    disabledHooks: new Set<HookName>(),
    requests: 0,
    tokens: 0,
    costUsd: 0,
    degraded: false,
    last: {},
  };
  const client = createClient({
    config,
    state,
    redact: createRedactor({ patterns: config.redaction.patterns }),
    log: () => {},
    status: () => {},
    cwd: process.cwd(),
  });
  if (!client.hasApiKey) {
    console.error(`replay needs an API key in ${config.apiKeyEnv}`);
    process.exit(1);
  }
  const records = loadRecords(path);
  const result = await replay(records, client.ask, limit);
  console.log(`replayed ${result.replayed} states, ${result.changed} changed`);
  for (const detail of result.details.slice(0, 20)) {
    console.log(`\n${detail.id}`);
    for (const diff of detail.diffs.filter((entry) => entry.changed)) {
      console.log(`  ${diff.id}: ${JSON.stringify(summarise(diff.before))} -> ${JSON.stringify(summarise(diff.after))}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main(process.argv.slice(2));
}
