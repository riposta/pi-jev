import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  createTelemetry,
  formatExplain,
  formatStatus,
  hashState,
  parseJsonl,
  readLog,
  sha256Hex,
  summarise,
  trimAnswers,
} from "../src/telemetry.ts";
import { makeConfig, makeState, noul, score } from "./helpers.ts";

describe("hashing", () => {
  it("canonicalJson sorts object keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("is stable for nested structures with different insertion order", () => {
    expect(canonicalJson({ x: { b: 1, a: 2 } })).toBe(canonicalJson({ x: { a: 2, b: 1 } }));
  });

  it("prefixes state hashes", () => {
    expect(hashState({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sha256Hex("x")).toHaveLength(64);
  });
});

describe("trimAnswers", () => {
  it("drops probability vectors but keeps the decision and confidence", () => {
    const trimmed = trimAnswers({ x: score(2.5, 0.8) }, false);
    expect(trimmed?.x).toMatchObject({ type: "score", score: 2.5, confidence: 0.8, probabilities: {} });
  });

  it("keeps probabilities when asked", () => {
    const full = trimAnswers({ y: noul(0.9) }, true);
    expect(full?.y).toEqual({ type: "noul", noul: 0.9 });
  });
});

describe("createTelemetry", () => {
  it("writes JSONL records to a dated file", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-telemetry-"));
    const config = makeConfig({ telemetry: { dir, logStateContent: false } });
    const telemetry = createTelemetry({ config, cwd: dir, now: () => Date.UTC(2026, 8, 18, 10, 0, 0) });
    telemetry.log({
      hook: "gate",
      questionsVersion: "abc",
      stateHash: "sha256:x",
      decision: "allow",
      shadow: true,
      answers: { reversible: noul(0.2) },
      state: { command: "rm -rf /" },
    });
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toEqual(["2026-09-18.jsonl"]);
    const records = parseJsonl(readFileSync(join(dir, files[0] as string), "utf8"));
    expect(records).toHaveLength(1);
    // logStateContent false strips the state centrally
    expect(records[0]?.state).toBeUndefined();
    expect(records[0]?.answers?.reversible).toEqual({ type: "noul", noul: 0.2 });
  });

  it("keeps the redacted state when logStateContent is on", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-telemetry-"));
    const config = makeConfig({ telemetry: { dir, logStateContent: true } });
    const telemetry = createTelemetry({ config, cwd: dir, now: () => Date.UTC(2026, 8, 18) });
    telemetry.log({
      hook: "router",
      questionsVersion: "v",
      stateHash: "s",
      decision: "cheap",
      shadow: true,
      state: { prompt: "hello" },
    });
    const records = parseJsonl(readFileSync(join(dir, "2026-09-18.jsonl"), "utf8"));
    expect(records[0]?.state).toEqual({ prompt: "hello" });
  });

  it("readLog parses files and summarise aggregates", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-telemetry-"));
    const config = makeConfig({ telemetry: { dir } });
    const telemetry = createTelemetry({ config, cwd: dir, now: () => Date.UTC(2026, 8, 18) });
    telemetry.log({ hook: "gate", questionsVersion: "v", stateHash: "s", decision: "confirm", shadow: true, userChoice: "deny", cached: true, usage: { input_tokens: 3, output_tokens: 2 } });
    telemetry.log({ hook: "router", questionsVersion: "v", stateHash: "s", decision: "cheap", shadow: true });
    const records = readLog({ dir, readdir: () => readdirSync(dir), readFile: (p) => readFileSync(p, "utf8") });
    expect(records).toHaveLength(2);
    const stats = summarise(records);
    expect(stats.total).toBe(2);
    expect(stats.byHook.gate).toBe(1);
    expect(stats.confirmLabels.deny).toBe(1);
    expect(stats.cacheHits).toBe(1);
    expect(stats.tokens).toBe(5);
  });
});

describe("formatting", () => {
  it("shows off with a reason", () => {
    expect(formatStatus(makeState({ layerEnabled: false, clientDisabledReason: "budget" }), makeConfig())).toBe(
      "jev off — budget",
    );
  });

  it("shows tier, requests and cost", () => {
    const state = makeState({ activeTier: "strong", requests: 14, costUsd: 0.03 });
    expect(formatStatus(state, makeConfig())).toBe("jev strong · 14 req · $0.03");
  });

  it("falls back to tokens when no price is configured", () => {
    const state = makeState({ activeTier: "cheap", requests: 2, tokens: 12_300 });
    expect(formatStatus(state, makeConfig())).toContain("12.3k tok");
  });

  it("explains a decision with its numbers", () => {
    const text = formatExplain({
      hook: "gate",
      questionsVersion: "v",
      stateHash: "s",
      decision: "allow",
      shadow: true,
      wouldHaveBeen: "block",
      reason: "irreversible",
      answers: { reversible: noul(0.1) },
      latencyMs: 12,
    });
    expect(text).toContain("would have been block");
    expect(text).toContain("irreversible");
    expect(text).toContain("reversible: 0.10");
  });
});
