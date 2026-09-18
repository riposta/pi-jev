/**
 * telemetry.ts — the JSONL log, the durable transcript entry, and the status
 * line.
 *
 * One record per classification, written to `<dir>/YYYY-MM-DD.jsonl`. Full
 * probability vectors are kept by default: without them threshold sweeping is
 * impossible (initial_plan.md §13.1). `logStateContent` is off by default, so the log holds
 * hashes rather than prompts.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { QUESTIONS_VERSION } from "./questions.ts";
import type { Answer, Config, SessionState, TelemetryRecord, TokenUsage } from "./types.ts";

/* -------------------------------------------------------------------------- */
/* Hashing helpers (shared with client.ts)                                    */
/* -------------------------------------------------------------------------- */

/** Deterministic JSON: object keys sorted, so equal states hash equally. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map(walk);
    if (seen.has(entry)) return "[circular]";
    seen.add(entry);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
      out[key] = walk((entry as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashState(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

export interface TelemetryDeps {
  config: Config;
  cwd: string;
  now?: () => number;
  /** Injectable for tests. */
  appendFile?: (path: string, data: string) => void;
  mkdir?: (path: string) => void;
}

export interface Telemetry {
  log(record: TelemetryRecord): void;
  /** Durable, non-LLM records kept in memory for /jev explain. */
  recent(): readonly TelemetryRecord[];
  lastFor(hook: TelemetryRecord["hook"]): TelemetryRecord | undefined;
  /** Absolute log directory. */
  dir(): string;
}

const HISTORY_LIMIT = 50;

function dateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Drops probability vectors unless the config asks to keep them. */
export function trimAnswers(
  answers: Record<string, Answer | undefined> | undefined,
  logProbabilities: boolean,
): Record<string, Answer | undefined> | undefined {
  if (!answers || logProbabilities) return answers;
  const out: Record<string, Answer | undefined> = {};
  for (const [key, answer] of Object.entries(answers)) {
    if (!answer) {
      out[key] = answer;
      continue;
    }
    if (answer.type === "choice") out[key] = { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities: {} };
    else if (answer.type === "score") out[key] = { type: "score", score: answer.score, confidence: answer.confidence, legend: answer.legend, probabilities: {} };
    else out[key] = { type: "noul", noul: answer.noul };
  }
  return out;
}

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const now = deps.now ?? (() => Date.now());
  const append = deps.appendFile ?? ((path: string, data: string) => appendFileSync(path, data));
  const makeDir = deps.mkdir ?? ((path: string) => void mkdirSync(path, { recursive: true }));
  const history: TelemetryRecord[] = [];

  const dir = isAbsolute(deps.config.telemetry.dir)
    ? deps.config.telemetry.dir
    : join(deps.cwd, deps.config.telemetry.dir);

  function log(record: TelemetryRecord): void {
    const stamped: TelemetryRecord = {
      ...record,
      ts: new Date(now()).toISOString(),
      questionsVersion: record.questionsVersion || QUESTIONS_VERSION,
    };
    // Privacy is enforced centrally, so no module can accidentally persist more
    // than the config allows.
    if (!deps.config.telemetry.logStateContent) delete stamped.state;
    stamped.answers = trimAnswers(stamped.answers, deps.config.telemetry.logProbabilities);
    history.push(stamped);
    if (history.length > HISTORY_LIMIT) history.shift();
    if (!deps.config.telemetry.enabled) return;
    try {
      makeDir(dir);
      append(join(dir, `${dateKey(now())}.jsonl`), `${JSON.stringify(stamped)}\n`);
    } catch {
      // Telemetry must never be the reason a session stops. Fail silent here;
      // the status line reports degraded state from the client, not the log.
    }
  }

  return {
    log,
    recent: () => history,
    lastFor: (hook) => [...history].reverse().find((entry) => entry.hook === hook),
    dir: () => dir,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading (stats, calibrate, replay)                                         */
/* -------------------------------------------------------------------------- */

/** Parses a JSONL file, skipping malformed lines rather than throwing. */
export function parseJsonl(text: string): TelemetryRecord[] {
  const out: TelemetryRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as TelemetryRecord);
    } catch {
      // Skip corrupt lines; a truncated final line is expected during a crash.
    }
  }
  return out;
}

export interface ReadLogOptions {
  dir: string;
  /** Inclusive ISO date (YYYY-MM-DD). Omit for all files. */
  since?: string;
  readFile?: (path: string) => string | undefined;
  readdir?: (path: string) => string[];
}

/** Reads every `*.jsonl` in `dir`, optionally only files on/after `since`. */
export function readLog(options: ReadLogOptions): TelemetryRecord[] {
  const readFile = options.readFile ?? (() => undefined);
  const readdir = options.readdir ?? (() => []);
  let files: string[];
  try {
    files = readdir(options.dir);
  } catch {
    return [];
  }
  const records: TelemetryRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".jsonl")).sort()) {
    if (options.since && file < `${options.since}.jsonl`) continue;
    const text = readFile(join(options.dir, file)) ?? readFileSafe(join(options.dir, file));
    if (text) records.push(...parseJsonl(text));
  }
  return records;
}

function readFileSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export interface Stats {
  total: number;
  byHook: Record<string, number>;
  byDecision: Record<string, number>;
  confirmLabels: { allow: number; deny: number; unknown: number };
  cacheHits: number;
  tokens: number;
}

/** Aggregates a decision mix and, for the gate, the labels from confirm prompts. */
export function summarise(records: readonly TelemetryRecord[]): Stats {
  const stats: Stats = {
    total: records.length,
    byHook: {},
    byDecision: {},
    confirmLabels: { allow: 0, deny: 0, unknown: 0 },
    cacheHits: 0,
    tokens: 0,
  };
  for (const record of records) {
    stats.byHook[record.hook] = (stats.byHook[record.hook] ?? 0) + 1;
    stats.byDecision[record.decision] = (stats.byDecision[record.decision] ?? 0) + 1;
    if (record.cached) stats.cacheHits += 1;
    if (record.usage) stats.tokens += record.usage.input_tokens + record.usage.output_tokens;
    if (record.hook === "gate" && record.userChoice) stats.confirmLabels[record.userChoice] += 1;
  }
  return stats;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

export function formatStatus(state: SessionState, config: Config): string {
  if (!state.layerEnabled) return `jev off${state.clientDisabledReason ? ` — ${state.clientDisabledReason}` : ""}`;
  if (state.clientDisabledReason) return `jev off — ${state.clientDisabledReason}`;
  const parts = [`jev ${state.activeTier ?? "idle"}`, `${state.requests} req`];
  if (state.costUsd > 0) parts.push(`$${state.costUsd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`);
  else if (state.tokens > 0) parts.push(`${(state.tokens / 1000).toFixed(1)}k tok`);
  if (state.degraded) parts.push("degraded");
  return parts.join(" · ");
}

/** Renders the last decision for `/jev explain`. */
export function formatExplain(record: TelemetryRecord | undefined): string {
  if (!record) return "jev: no decisions recorded yet.";
  const lines = [
    `hook: ${record.hook}${record.tool ? ` (${record.tool})` : ""}`,
    `decision: ${record.decision}${record.shadow ? " [shadow]" : ""}${
      record.wouldHaveBeen && record.wouldHaveBeen !== record.decision
        ? ` (would have been ${record.wouldHaveBeen})`
        : ""
    }`,
  ];
  if (record.reason) lines.push(`reason: ${record.reason}`);
  if (record.answers) {
    for (const [id, answer] of Object.entries(record.answers)) {
      if (!answer) continue;
      if (answer.type === "noul") lines.push(`  ${id}: ${answer.noul.toFixed(2)}`);
      else if (answer.type === "choice")
        lines.push(`  ${id}: ${answer.choice} (confidence ${answer.confidence.toFixed(2)})`);
      else lines.push(`  ${id}: ${answer.score.toFixed(2)} (confidence ${answer.confidence.toFixed(2)})`);
    }
  }
  if (record.latencyMs !== undefined) lines.push(`latency: ${record.latencyMs} ms${record.cached ? " (cached)" : ""}`);
  if (record.usage) lines.push(`tokens: ${record.usage.input_tokens} in / ${record.usage.output_tokens} out`);
  return lines.join("\n");
}
