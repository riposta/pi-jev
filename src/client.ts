/**
 * client.ts — the only file that talks to TypeSafe.
 *
 * Everything else receives `ask` through `Deps`. A `null` return is the single
 * failure signal; modules branch on it once into their fail-open path. The
 * client never throws into a hook handler (initial_plan.md §6.1).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QUESTIONS_VERSION } from "./questions.ts";
import {
  canonicalJson,
  formatStatus,
  hashState,
  sha256Hex,
} from "./telemetry.ts";
import type {
  Answer,
  Answers,
  AskFn,
  AskOptions,
  Config,
  HookName,
  QuestionSet,
  RedactFn,
  SessionState,
  TelemetryFn,
  TokenUsage,
} from "./types.ts";
import { timeouts } from "./config.ts";

export interface ClientDeps {
  config: Config;
  state: SessionState;
  log: TelemetryFn;
  redact: RedactFn;
  status(text: string | undefined): void;
  cwd: string;
  /** Pi's config directory name. Defaults to ".pi". */
  configDirName?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Disk cache I/O, injectable for tests. */
  readFile?: (path: string) => string | undefined;
  writeFile?: (path: string, data: string) => void;
  mkdir?: (path: string) => void;
}

export interface Client {
  ask: AskFn;
  hasApiKey: boolean;
  disabledReason: string | null;
  /** Cache and request counters, for tests and `/jev`. */
  readonly debug: {
    memSize(): number;
    diskHits: number;
    memHits: number;
    inflightCoalesced: number;
    requests: number;
  };
  /** Clears in-memory and on-disk caches. Used after a questions edit in tests. */
  clearCache(): void;
}

interface CacheEntry {
  answers: Record<string, Answer>;
  at: number;
}

interface DiskCacheFile {
  version: string;
  entries: Record<string, CacheEntry>;
}

const MEM_CACHE_LIMIT = 500;
const DISK_CACHE_LIMIT = 1000;

/* -------------------------------------------------------------------------- */
/* Wire helpers                                                              */
/* -------------------------------------------------------------------------- */

interface WireAnswer {
  type: string;
  choice?: string;
  score?: number;
  noul?: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedResponseError";
  }
}

export function buildWireQuestions(questions: QuestionSet): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    wire[id] = question;
  }
  return wire;
}

function toAnswer(id: string, raw: WireAnswer): Answer {
  if (raw.type === "choice" && typeof raw.choice === "string") {
    return {
      type: "choice",
      choice: raw.choice,
      probabilities: raw.probabilities ?? {},
      confidence: raw.confidence ?? 0,
    };
  }
  if (raw.type === "score" && typeof raw.score === "number") {
    return {
      type: "score",
      score: raw.score,
      legend: raw.legend ?? {},
      probabilities: raw.probabilities ?? {},
      confidence: raw.confidence ?? 0,
    };
  }
  if (raw.type === "noul" && typeof raw.noul === "number") {
    return { type: "noul", noul: raw.noul };
  }
  throw new MalformedResponseError(`Answer for "${id}" has an unexpected shape: ${JSON.stringify(raw)}`);
}

export function parseAnswers(
  questions: QuestionSet,
  body: { answers?: Record<string, WireAnswer> },
): Record<string, Answer> {
  if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") {
    throw new MalformedResponseError("Response has no answers object");
  }
  const out: Record<string, Answer> = {};
  for (const id of Object.keys(questions)) {
    const raw = body.answers[id];
    if (!raw) throw new MalformedResponseError(`Response is missing an answer for "${id}"`);
    out[id] = toAnswer(id, raw);
  }
  return out;
}

function extractUsage(body: { usage?: TokenUsage }): TokenUsage {
  return {
    input_tokens: body.usage?.input_tokens ?? 0,
    output_tokens: body.usage?.output_tokens ?? 0,
  };
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function questionIdFromError(body: string): string | undefined {
  // TypeSafe 422 bodies are not documented in the public API reference. Try the
  // common shapes and fall back to undefined.
  const match = body.match(/"?(?:question|param|field|location)"?\s*[:=]\s*"?([A-Za-z0-9_]+)"?/);
  return match?.[1];
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export function createClient(deps: ClientDeps): Client {
  const { config, state } = deps;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const mkdir = deps.mkdir ?? ((path: string) => void mkdirSync(path, { recursive: true }));
  const readFile =
    deps.readFile ??
    ((path: string): string | undefined => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    });
  const writeFile = deps.writeFile ?? ((path: string, data: string) => writeFileSync(path, data));

  const apiKey = env[config.apiKeyEnv];
  const hasApiKey = typeof apiKey === "string" && apiKey.length > 0;
  let disabledReason: string | null = hasApiKey ? null : `no ${config.apiKeyEnv}`;
  if (disabledReason) state.clientDisabledReason = disabledReason;

  const mem = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<unknown>>();
  const strikes = new Map<HookName, number>();
  const debug = {
    diskHits: 0,
    memHits: 0,
    inflightCoalesced: 0,
    requests: 0,
    memSize: () => mem.size,
  };

  const cacheDir = join(deps.cwd, deps.configDirName ?? ".pi");
  const cachePath = join(cacheDir, "jev-cache.json");
  let disk: DiskCacheFile | undefined;
  let diskLoaded = false;

  function loadDisk(): DiskCacheFile {
    if (diskLoaded && disk) return disk;
    diskLoaded = true;
    let parsed: unknown;
    try {
      const raw = readFile(cachePath);
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      // Corrupt cache: discard and rebuild silently (initial_plan.md §16).
      parsed = undefined;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as DiskCacheFile).version === QUESTIONS_VERSION &&
      typeof (parsed as DiskCacheFile).entries === "object"
    ) {
      disk = parsed as DiskCacheFile;
    } else {
      disk = { version: QUESTIONS_VERSION, entries: {} };
    }
    return disk;
  }

  function saveDisk(): void {
    if (!disk) return;
    try {
      mkdir(cacheDir);
      writeFile(cachePath, JSON.stringify(disk));
    } catch {
      // Disk cache is best-effort.
    }
  }

  function memGet(key: string): CacheEntry | undefined {
    const entry = mem.get(key);
    if (!entry) return undefined;
    // LRU: refresh recency.
    mem.delete(key);
    mem.set(key, entry);
    return entry;
  }

  function memSet(key: string, entry: CacheEntry): void {
    if (mem.has(key)) mem.delete(key);
    mem.set(key, entry);
    if (mem.size > MEM_CACHE_LIMIT) {
      const oldest = mem.keys().next().value as string | undefined;
      if (oldest !== undefined) mem.delete(oldest);
    }
  }

  function updateStatus(): void {
    deps.status(formatStatus(state, config));
  }

  function disableSession(reason: string, record?: Record<string, unknown>): null {
    disabledReason = reason;
    state.clientDisabledReason = reason;
    deps.log({
      hook: "client",
      questionsVersion: QUESTIONS_VERSION,
      stateHash: "sha256:none",
      decision: "disabled",
      shadow: false,
      reason,
      ...record,
    });
    updateStatus();
    return null;
  }

  function breachBudget(): null {
    const { maxRequestsPerSession, maxTokensPerSession, onBreach } = config.budget;
    const breached =
      state.requests >= maxRequestsPerSession || state.tokens >= maxTokensPerSession;
    if (!breached) return null;
    const reason = "budget";
    deps.log({
      hook: "client",
      questionsVersion: QUESTIONS_VERSION,
      stateHash: "sha256:none",
      decision: onBreach === "disable" ? "disabled" : "warn",
      shadow: false,
      reason,
      detail: { requests: state.requests, tokens: state.tokens },
    });
    if (onBreach === "disable") return disableSession(reason);
    state.degraded = true;
    updateStatus();
    return null;
  }

  async function performRequest(
    hook: HookName,
    stateForRequest: unknown,
    questions: QuestionSet,
    signal: AbortSignal | undefined,
  ): Promise<{ answers: Record<string, Answer>; usage: TokenUsage; latencyMs: number; answeredModel?: string }> {
    const started = now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeouts(config)[hook]);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const body = JSON.stringify({
      model: config.model,
      state: stateForRequest,
      questions: buildWireQuestions(questions),
    });
    const url = `${config.baseUrl.replace(/\/$/, "")}/v1/systemone`;

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let response: Response;
        try {
          response = await doFetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body,
            signal: controller.signal,
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          if (timedOut || isAbortError(error)) {
            const wrapped = new Error("timeout") as Error & { kind: string };
            wrapped.kind = "timeout";
            throw wrapped;
          }
          const wrapped = new Error((error as Error).message) as Error & { kind: string };
          wrapped.kind = "network";
          throw wrapped;
        }

        if (response.status === 429 || response.status === 529) {
          const retryAfter = Number(response.headers.get("retry-after")) * 1000;
          if (attempt < 2) {
            // Drain the body so the retry does not leak the connection.
            await response.body?.cancel().catch(() => undefined);
            await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 2000) : 250 * 2 ** attempt);
            continue;
          }
          const wrapped = new Error(`http ${response.status}`) as Error & { kind: string; status: number };
          wrapped.kind = "timeout";
          wrapped.status = response.status;
          throw wrapped;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const wrapped = new Error(`http ${response.status}`) as Error & {
            kind: string;
            status: number;
            body: string;
          };
          wrapped.kind = "http";
          wrapped.status = response.status;
          wrapped.body = text.slice(0, 2000);
          throw wrapped;
        }

        const parsed = (await response.json()) as {
          answers?: Record<string, WireAnswer>;
          usage?: TokenUsage;
          model?: string;
        };
        const answers = parseAnswers(questions, parsed);
        const answeredModel = typeof parsed.model === "string" ? parsed.model : undefined;
        return { answers, usage: extractUsage(parsed), latencyMs: now() - started, answeredModel };
      }
      throw new Error("unreachable");
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  function recordFailure(hook: HookName, reason: string, detail?: Record<string, unknown>): null {
    const count = (strikes.get(hook) ?? 0) + 1;
    strikes.set(hook, count);
    state.degraded = count > 0;
    deps.log({
      hook: "client",
      questionsVersion: QUESTIONS_VERSION,
      stateHash: "sha256:none",
      decision: "failure",
      shadow: false,
      error: reason,
      detail: { requestHook: hook, strikes: count, ...detail },
    });
    if (count >= 3) {
      state.disabledHooks.add(hook);
      deps.log({
        hook: "client",
        questionsVersion: QUESTIONS_VERSION,
        stateHash: "sha256:none",
        decision: "disabled",
        shadow: false,
        reason: `${hook}: three consecutive failures`,
      });
    }
    updateStatus();
    return null;
  }

  const ask = (async <Q extends QuestionSet>(
    hook: HookName,
    rawState: unknown,
    questions: Q,
    opts: AskOptions = {},
  ): Promise<{ answers: Answers<Q>; meta: ReturnType<typeof makeMeta> } | null> => {
    if (!state.layerEnabled) return null;
    if (disabledReason) return null;
    if (state.disabledHooks.has(hook)) return null;
    if (opts.signal?.aborted) return null;
    breachBudget();
    if (disabledReason) return null;

    const redactedRaw = deps.redact.deep(rawState);
    const budget = stateCharBudget(deps.config);
    const redacted = budget > 0 ? truncateState(redactedRaw, budget) : redactedRaw;

    const stateHash = hashState(redacted);
    const memKey = `${hook}:${QUESTIONS_VERSION}:${sha256Hex(
      canonicalJson({ state: redacted, questions }),
    )}`;

    if (opts.allowCache !== false) {
      const cached = memGet(memKey);
      if (cached) {
        debug.memHits += 1;
        return {
          answers: cached.answers as Answers<Q>,
          meta: makeMeta({ hook, cached: true, latencyMs: 0, stateHash, redactedState: redacted }),
        };
      }
    }

    const existing = inflight.get(memKey);
    if (existing) {
      debug.inflightCoalesced += 1;
      return (await existing) as { answers: Answers<Q>; meta: ReturnType<typeof makeMeta> } | null;
    }

    // On-disk command cache, gate only (initial_plan.md §6.3).
    let diskKey: string | undefined;
    if (hook === "gate" && config.modules.gate.diskCache && opts.cacheKey) {
      diskKey = `gate:${opts.cacheKey}`;
      const entry = loadDisk().entries[diskKey];
      if (entry) {
        debug.diskHits += 1;
        memSet(memKey, entry);
        return {
          answers: entry.answers as Answers<Q>,
          meta: makeMeta({ hook, cached: true, latencyMs: 0, stateHash, redactedState: redacted }),
        };
      }
    }

    const task = (async () => {
      try {
        const result = await performRequest(hook, redacted, questions, opts.signal);
        strikes.delete(hook);
        state.degraded = false;
        state.requests += 1;
        state.tokens += result.usage.input_tokens + result.usage.output_tokens;
        state.costUsd += cost(result.usage, config);
        debug.requests += 1;
        const entry: CacheEntry = { answers: result.answers, at: now() };
        memSet(memKey, entry);
        if (diskKey) {
          const diskCache = loadDisk();
          diskCache.entries[diskKey] = entry;
          evictDisk(diskCache);
          saveDisk();
        }
        updateStatus();
        breachBudget();
        return {
          answers: result.answers as Answers<Q>,
          meta: makeMeta({
            hook,
            cached: false,
            latencyMs: result.latencyMs,
            stateHash,
            usage: result.usage,
            answeredModel: result.answeredModel,
            redactedState: redacted,
          }),
        };
      } catch (error) {
        const err = error as Error & { kind?: string; status?: number; body?: string };
        if (err.kind === "http" && err.status === 401) {
          return disableSession("unauthorized (401)", { error: err.message });
        }
        if (err.kind === "http" && err.status === 422) {
          const questionId = questionIdFromError(err.body ?? "");
          state.disabledHooks.add(hook);
          deps.log({
            hook: "client",
            questionsVersion: QUESTIONS_VERSION,
            stateHash,
            decision: "disabled",
            shadow: false,
            error: `422 unprocessable${questionId ? ` on question "${questionId}"` : ""}`,
            detail: { requestHook: hook, questionId },
          });
          updateStatus();
          return null;
        }
        if (opts.signal?.aborted) return null;
        return recordFailure(hook, err.kind === "timeout" ? "timeout" : err.message);
      }
    })();

    inflight.set(memKey, task);
    try {
      return (await task) as { answers: Answers<Q>; meta: ReturnType<typeof makeMeta> } | null;
    } finally {
      inflight.delete(memKey);
    }
  }) as unknown as AskFn;

  function makeMeta(input: {
    hook: HookName;
    cached: boolean;
    latencyMs: number;
    stateHash: string;
    usage?: TokenUsage;
    answeredModel?: string;
    redactedState: unknown;
  }) {
    return {
      hook: input.hook,
      model: config.model,
      answeredModel: input.answeredModel,
      latencyMs: input.latencyMs,
      cached: input.cached,
      stateHash: input.stateHash,
      questionsVersion: QUESTIONS_VERSION,
      usage: input.usage ?? { input_tokens: 0, output_tokens: 0 },
      redactedState: input.redactedState,
    };
  }

  return {
    ask,
    hasApiKey,
    get disabledReason() {
      return disabledReason;
    },
    debug,
    clearCache() {
      mem.clear();
      disk = { version: QUESTIONS_VERSION, entries: {} };
      diskLoaded = true;
      saveDisk();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

export function cost(usage: TokenUsage, config: Config): number {
  return (
    (usage.input_tokens * config.budget.inputPricePerMTok +
      usage.output_tokens * config.budget.outputPricePerMTok) /
    1_000_000
  );
}

/**
 * The tightest of the character cap and the token cap. Tokens are estimated at
 * ~4 characters, which is close enough for an English/mixed state and keeps the
 * request under Jev's `state + longest question` ceiling. Returns 0 when no
 * budget is configured.
 */
export function stateCharBudget(config: Config): number {
  const byChars = config.redaction.maxStateChars > 0 ? config.redaction.maxStateChars : Number.POSITIVE_INFINITY;
  const byTokens =
    config.redaction.maxStateTokens > 0 ? config.redaction.maxStateTokens * 4 : Number.POSITIVE_INFINITY;
  const budget = Math.min(byChars, byTokens);
  return Number.isFinite(budget) ? budget : 0;
}

function truncateStrings(value: unknown, limit: number): unknown {
  if (typeof value === "string") {
    return value.length > limit ? `${value.slice(0, limit)}…[truncated by pi-jev]` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => truncateStrings(entry, limit));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = truncateStrings(entry, limit);
    return out;
  }
  return value;
}

/**
 * Truncates state to the configured character budget by shortening string
 * leaves in place. Earlier this returned a bare JSON string, which changes the
 * wire type of `state` and can make the API answer `422` (disabling the hook
 * for the session). Keeping the object shape lets the questions still resolve
 * their fields.
 */
export function truncateState(state: unknown, maxChars: number): unknown {
  const serialised = JSON.stringify(state);
  if (serialised === undefined || serialised.length <= maxChars) return state;
  let limit = Math.max(1_000, Math.floor(maxChars / 4));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = truncateStrings(state, limit);
    if ((JSON.stringify(candidate) ?? "").length <= maxChars) return candidate;
    limit = Math.floor(limit / 2);
    if (limit < 100) break;
  }
  return truncateStrings(state, 100);
}

function evictDisk(cache: DiskCacheFile): void {
  const keys = Object.keys(cache.entries);
  if (keys.length <= DISK_CACHE_LIMIT) return;
  keys
    .sort((a, b) => (cache.entries[a]?.at ?? 0) - (cache.entries[b]?.at ?? 0))
    .slice(0, keys.length - DISK_CACHE_LIMIT)
    .forEach((key) => delete cache.entries[key]);
}
