import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePrune, failureSuggestion, pruneOutput, type PruneAnswers } from "../src/modules/prune.ts";
import { choice, makeConfig, score } from "./helpers.ts";

function answers(relevance: number, failure = "none"): PruneAnswers {
  return { relevance: score(relevance), failure_type: choice(failure) } as PruneAnswers;
}

describe("prune decision", () => {
  it("never prunes when the module is disabled", () => {
    const config = makeConfig({ modules: { prune: { enabled: false, minLines: 10 } } });
    expect(evaluatePrune(answers(0.1), config, 10_000).prune).toBe(false);
  });

  it("skips outputs shorter than minLines", () => {
    const config = makeConfig({ modules: { prune: { enabled: true, minLines: 150 } } });
    expect(evaluatePrune(answers(0.1), config, 149).prune).toBe(false);
    expect(evaluatePrune(answers(0.1), config, 150).prune).toBe(true);
  });

  it("prunes only below the relevance threshold", () => {
    const config = makeConfig({ modules: { prune: { enabled: true, minLines: 1 } } });
    expect(evaluatePrune(answers(0.59), config, 500).prune).toBe(true);
    expect(evaluatePrune(answers(0.6), config, 500).prune).toBe(false);
  });
});

describe("prune output", () => {
  it("writes the full output to a temp file and returns a pointer", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-prune-"));
    const raw = "first line\n" + "x".repeat(1000);
    const result = pruneOutput(raw, "call/with:bad*chars", dir);
    expect(result.path).toContain("pi-jev-call_with_bad_chars.txt");
    expect(readFileSync(result.path, "utf8")).toBe(raw);
    expect(result.notice).toContain("first line");
    expect(result.notice).toContain(result.path);
  });
});

describe("failure suggestions", () => {
  it("suggests a retry for flakiness and an env check otherwise", () => {
    expect(failureSuggestion(answers(0.5, "flaky"))).toContain("Retry");
    expect(failureSuggestion(answers(0.5, "env_problem"))).toContain("environmental");
    expect(failureSuggestion(answers(0.5, "real_error"))).toBeNull();
    expect(failureSuggestion(answers(0.5, "none"))).toBeNull();
  });
});
