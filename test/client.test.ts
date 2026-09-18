import { afterEach, describe, expect, it } from "vitest";
import { createClient, MalformedResponseError, parseAnswers, truncateState } from "../src/client.ts";
import { createRedactor } from "../src/redact.ts";
import { choice, makeConfig, makeState, memoryFs, noul, score, startMockJev, type MockJev } from "./helpers.ts";
import type { QuestionSet, SessionState, TelemetryRecord } from "../src/types.ts";

const QUESTIONS: QuestionSet = {
  reversible: { type: "noul", instructions: "reversible?" },
};

async function setup(
  configPatch: unknown,
  server: MockJev,
  state: SessionState = makeState(),
): Promise<{
  client: ReturnType<typeof createClient>;
  state: SessionState;
  records: TelemetryRecord[];
  statuses: (string | undefined)[];
  fs: ReturnType<typeof memoryFs>;
}> {
  const config = makeConfig({ baseUrl: server.url, ...(configPatch as object) });
  const records: TelemetryRecord[] = [];
  const statuses: (string | undefined)[] = [];
  const fs = memoryFs();
  const client = createClient({
    config,
    state,
    redact: createRedactor(),
    log: (record) => records.push(record),
    status: (text) => statuses.push(text),
    cwd: "/repo",
    env: { TYPESAFE_API_KEY: "test-key" },
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    mkdir: fs.mkdir,
  });
  return { client, state, records, statuses, fs };
}

let servers: MockJev[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

async function server(options: Parameters<typeof startMockJev>[0] = {}): Promise<MockJev> {
  const created = await startMockJev(options);
  servers.push(created);
  return created;
}

describe("client ask", () => {
  it("returns parsed answers, usage and account state", async () => {
    const mock = await server({ answers: { reversible: noul(0.12) }, usage: { input_tokens: 400, output_tokens: 20 } });
    const { client, state } = await setup({ budget: { inputPricePerMTok: 1_000_000, outputPricePerMTok: 1_000_000 } }, mock);
    const result = await client.ask("gate", { command: "x" }, QUESTIONS);
    expect(result?.answers.reversible).toEqual({ type: "noul", noul: 0.12 });
    expect(result?.meta.cached).toBe(false);
    expect(state.requests).toBe(1);
    expect(state.tokens).toBe(420);
    expect(state.costUsd).toBeCloseTo(420, 5);
    expect(mock.requests[0]?.auth).toBe("Bearer test-key");
  });

  it("parses choice and score answers", async () => {
    const mock = await server({ answers: { task_type: choice("feature", 0.8), reasoning_needed: score(2.4, 0.7) } });
    const { client } = await setup({}, mock);
    const questions: QuestionSet = {
      task_type: { type: "choice", instructions: "?", criteria: { feature: "f", other: "o" } },
      reasoning_needed: { type: "score", instructions: "?", criteria: ["a", "b", "c"] },
    };
    const result = await client.ask("router", { prompt: "x" }, questions);
    expect(result?.answers.task_type).toMatchObject({ type: "choice", choice: "feature", confidence: 0.8 });
    expect(result?.answers.reasoning_needed).toMatchObject({ type: "score", score: 2.4 });
  });

  it("serves a repeated identical request from the in-memory cache", async () => {
    const mock = await server();
    const { client, state } = await setup({}, mock);
    const first = await client.ask("router", { prompt: "same" }, QUESTIONS);
    const second = await client.ask("router", { prompt: "same" }, QUESTIONS);
    expect(first?.meta.cached).toBe(false);
    expect(second?.meta.cached).toBe(true);
    expect(mock.requests).toHaveLength(1);
    expect(state.requests).toBe(1);
    expect(client.debug.memHits).toBe(1);
  });

  it("uses the on-disk gate cache across client instances", async () => {
    const mock = await server();
    const fs = memoryFs();
    const config = makeConfig({ baseUrl: mock.url, modules: { gate: { diskCache: true } } });
    const mk = () =>
      createClient({
        config,
        state: makeState(),
        redact: createRedactor(),
        log: () => {},
        status: () => {},
        cwd: "/repo",
        env: { TYPESAFE_API_KEY: "k" },
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        mkdir: fs.mkdir,
      });
    const first = mk();
    await first.ask("gate", { command: "git push --force" }, QUESTIONS, { cacheKey: "git push --force" });
    const second = mk();
    const result = await second.ask("gate", { command: "git push --force" }, QUESTIONS, { cacheKey: "git push --force" });
    expect(result?.meta.cached).toBe(true);
    expect(mock.requests).toHaveLength(1);
    expect(second.debug.diskHits).toBe(1);
  });

  it("redacts the state before sending it", async () => {
    const mock = await server();
    const { client } = await setup({}, mock);
    await client.ask("gate", { command: "curl -H 'Authorization: Bearer supersecrettoken123' example.com" }, QUESTIONS);
    const body = JSON.stringify(mock.requests[0]?.body);
    expect(body).not.toContain("supersecrettoken123");
    expect(body).toContain("[redacted]");
  });

  it("disables the session on 401", async () => {
    const mock = await server({ failures: 1, failureStatus: 401, failureBody: '{"error":"nope"}' });
    const { client, state } = await setup({}, mock);
    const result = await client.ask("gate", { command: "x" }, QUESTIONS);
    expect(result).toBeNull();
    expect(state.clientDisabledReason).toBe("unauthorized (401)");
    // further asks short-circuit without another request
    await client.ask("gate", { command: "y" }, QUESTIONS);
    expect(mock.requests).toHaveLength(1);
  });

  it("disables the offending hook on 422 and logs the question id", async () => {
    const mock = await server({ failures: 1, failureStatus: 422, failureBody: '{"question":"blast_radius"}' });
    const { client, state, records } = await setup({}, mock);
    const result = await client.ask("gate", { command: "x" }, QUESTIONS);
    expect(result).toBeNull();
    expect(state.disabledHooks.has("gate")).toBe(true);
    expect(records.some((record) => record.error?.includes("blast_radius"))).toBe(true);
  });

  it("resolves null on timeout and disables after three strikes", async () => {
    const mock = await server({ delayMs: 250 });
    const { client, state } = await setup({ modules: { gate: { timeoutMs: 30 } } }, mock);
    for (let index = 0; index < 4; index += 1) {
      const result = await client.ask("gate", { command: `x${index}` }, QUESTIONS);
      expect(result).toBeNull();
    }
    expect(state.disabledHooks.has("gate")).toBe(true);
    // only three attempts reached the network
    expect(mock.requests).toHaveLength(3);
    expect(state.degraded).toBe(true);
  });

  it("handles network failures with the same three-strike rule", async () => {
    const failing: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const config = makeConfig({ baseUrl: "http://127.0.0.1:1" });
    const state = makeState();
    const client = createClient({
      config,
      state,
      redact: createRedactor(),
      log: () => {},
      status: () => {},
      cwd: "/repo",
      env: { TYPESAFE_API_KEY: "k" },
      fetchImpl: failing,
    });
    for (let index = 0; index < 3; index += 1) await client.ask("router", { prompt: `p${index}` }, QUESTIONS);
    expect(state.disabledHooks.has("router")).toBe(true);
  });

  it("disables on budget breach when configured to", async () => {
    const mock = await server();
    const { client, state } = await setup({ budget: { maxRequestsPerSession: 2, onBreach: "disable" } }, mock);
    await client.ask("router", { prompt: "a" }, QUESTIONS);
    await client.ask("router", { prompt: "b" }, QUESTIONS);
    const third = await client.ask("router", { prompt: "c" }, QUESTIONS);
    expect(third).toBeNull();
    expect(state.clientDisabledReason).toBe("budget");
  });

  it("does not call fetch when the signal is already aborted", async () => {
    let called = 0;
    const mock = await server();
    const config = makeConfig({ baseUrl: mock.url });
    const client = createClient({
      config,
      state: makeState(),
      redact: createRedactor(),
      log: () => {},
      status: () => {},
      cwd: "/repo",
      env: { TYPESAFE_API_KEY: "k" },
      fetchImpl: async (...args) => {
        called += 1;
        return fetch(...args);
      },
    });
    const controller = new AbortController();
    controller.abort();
    const result = await client.ask("gate", { command: "x" }, QUESTIONS, { signal: controller.signal });
    expect(result).toBeNull();
    expect(called).toBe(0);
  });

  it("returns null when no API key is configured", async () => {
    const mock = await server();
    const config = makeConfig({ baseUrl: mock.url });
    const state = makeState();
    const client = createClient({
      config,
      state,
      redact: createRedactor(),
      log: () => {},
      status: () => {},
      cwd: "/repo",
      env: {},
    });
    expect(client.hasApiKey).toBe(false);
    expect(await client.ask("gate", { command: "x" }, QUESTIONS)).toBeNull();
    expect(state.clientDisabledReason).toContain("TYPESAFE_API_KEY");
    expect(mock.requests).toHaveLength(0);
  });
});

describe("state truncation", () => {
  it("truncates string leaves but keeps state an object under the budget", () => {
    const big = "x".repeat(10_000);
    const out = truncateState({ prompt: big, nested: { tool_output: big } }, 2_000);
    expect(typeof out).toBe("object");
    const record = out as { prompt: string; nested: { tool_output: string } };
    expect(record.prompt).toContain("[truncated by pi-jev]");
    expect(record.nested.tool_output).toContain("[truncated by pi-jev]");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2_000);
  });

  it("returns small state untouched", () => {
    const state = { prompt: "hi" };
    expect(truncateState(state, 1_000)).toBe(state);
  });
});

describe("response parsing", () => {
  it("rejects a response missing a requested answer", () => {
    expect(() => parseAnswers(QUESTIONS, { answers: {} })).toThrow(MalformedResponseError);
  });

  it("rejects an answer with an unexpected shape", () => {
    expect(() => parseAnswers(QUESTIONS, { answers: { reversible: { type: "noul" } } })).toThrow(MalformedResponseError);
  });
});
