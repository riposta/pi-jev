/**
 * Shared test fixtures.
 *
 * The important part is `startMockJev`: a real local HTTP server speaking the
 * TypeSafe wire shape. Client and integration tests run against it, so the
 * request/response contract is exercised for real rather than mocked at the
 * fetch boundary.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRedactor } from "../src/redact.ts";
import { defaultConfig, deepMerge } from "../src/config.ts";
import type {
  Answer,
  ChoiceAnswer,
  Config,
  Deps,
  NoulAnswer,
  RedactFn,
  ScoreAnswer,
  SessionState,
  TelemetryRecord,
} from "../src/types.ts";

export function makeConfig(patch: unknown = {}): Config {
  return deepMerge(defaultConfig(), patch);
}

export function makeState(patch: Partial<SessionState> = {}): SessionState {
  return {
    layerEnabled: true,
    shadow: { router: true, gate: true, shield: true, prune: true, watchdog: true },
    clientDisabledReason: null,
    disabledHooks: new Set(),
    requests: 0,
    tokens: 0,
    costUsd: 0,
    degraded: false,
    last: {},
    ...patch,
  };
}

export function identityRedact(): RedactFn {
  const fn = ((text: string) => text) as RedactFn;
  fn.deep = (value) => value;
  return fn;
}

export interface RecordingDeps {
  deps: Deps;
  records: TelemetryRecord[];
  entries: TelemetryRecord[];
  statuses: (string | undefined)[];
}

export function makeDeps(overrides: Partial<Deps> = {}): RecordingDeps {
  const records: TelemetryRecord[] = [];
  const entries: TelemetryRecord[] = [];
  const statuses: (string | undefined)[] = [];
  const deps: Deps = {
    config: makeConfig(),
    ask: async () => null,
    log: (record) => records.push(record),
    redact: identityRedact(),
    state: makeState(),
    status: (text) => statuses.push(text),
    appendEntry: (record) => entries.push(record),
    now: () => 0,
    ...overrides,
  };
  return { deps, records, entries, statuses };
}

/* -------------------------------------------------------------------------- */
/* Answer builders                                                            */
/* -------------------------------------------------------------------------- */

export function choice(value: string, confidence = 0.9): ChoiceAnswer {
  return { type: "choice", choice: value, probabilities: { [value]: confidence }, confidence };
}

export function score(value: number, confidence = 0.9): ScoreAnswer {
  return { type: "score", score: value, legend: {}, probabilities: { "0": 1 - value, [String(value)]: value }, confidence };
}

export function noul(value: number): NoulAnswer {
  return { type: "noul", noul: value };
}

/* -------------------------------------------------------------------------- */
/* Mock TypeSafe server                                                       */
/* -------------------------------------------------------------------------- */

export interface MockJevOptions {
  /** HTTP status for the first `failures` requests, then 200. */
  failures?: number;
  failureStatus?: number;
  failureBody?: string;
  delayMs?: number;
  /** Overrides individual answers; unknown ids get a benign default. */
  answers?: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface MockJev {
  url: string;
  requests: Array<{ url: string; auth: string | undefined; body: unknown }>;
  close(): Promise<void>;
  setAnswers(answers: Record<string, Answer>): void;
}

export async function startMockJev(options: MockJevOptions = {}): Promise<MockJev> {
  let remainingFailures = options.failures ?? 0;
  const state = { answers: options.answers ?? {} };
  const requests: MockJev["requests"] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ url: req.url ?? "", auth: req.headers.authorization, body });

      const respond = () => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          res.statusCode = options.failureStatus ?? 500;
          res.setHeader("content-type", "application/json");
          res.end(options.failureBody ?? '{"error":"boom"}');
          return;
        }
        const requestBody = body as { questions?: Record<string, { type: string }> } | undefined;
        const answers: Record<string, Answer> = {};
        for (const [id, question] of Object.entries(requestBody?.questions ?? {})) {
          answers[id] = state.answers[id] ?? defaultAnswer(id, question.type);
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: "jev-latest", answers, usage: options.usage ?? { input_tokens: 10, output_tokens: 5 } }));
      };

      if (options.delayMs) setTimeout(respond, options.delayMs);
      else respond();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setAnswers: (answers) => {
      state.answers = answers;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function defaultAnswer(_id: string, type: string): Answer {
  if (type === "noul") return noul(0.05);
  if (type === "score") return score(0);
  return choice("other");
}

/** In-memory filesystem used to exercise the disk cache without touching disk. */
export function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: (path: string) => files.get(path),
    writeFile: (path: string, data: string) => void files.set(path, data),
    mkdir: () => {},
  };
}

export { createRedactor };
