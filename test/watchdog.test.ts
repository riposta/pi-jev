import { describe, expect, it } from "vitest";
import {
  claimsCompletion,
  commandIsEvidence,
  evaluateWatchdog,
  loopMessage,
  verifyMessage,
  type WatchdogAnswers,
} from "../src/modules/watchdog.ts";
import { summariseTurn, firstLine, errorLines } from "../src/messages.ts";
import { makeConfig, noul, score } from "./helpers.ts";

function answers(patch: Partial<WatchdogAnswers> = {}): WatchdogAnswers {
  return { progress: score(2, 0.9), looping: noul(0.1), false_done: noul(0.1), ...patch } as WatchdogAnswers;
}

describe("watchdog decision", () => {
  it("fires on looping above the threshold", () => {
    expect(evaluateWatchdog(answers({ looping: noul(0.9) }), makeConfig()).inject).toBe("loop");
    expect(evaluateWatchdog(answers({ looping: noul(0.75) }), makeConfig()).looping).toBe(false);
  });

  it("asks for verification on a false completion", () => {
    const decision = evaluateWatchdog(answers({ false_done: noul(0.9) }), makeConfig());
    expect(decision.falseDone).toBe(true);
    expect(decision.inject).toBe("verify");
  });

  it("prefers the loop injection when both fire", () => {
    expect(evaluateWatchdog(answers({ looping: noul(0.9), false_done: noul(0.9) }), makeConfig()).inject).toBe("loop");
  });

  it("carries the progress score for the status line", () => {
    expect(evaluateWatchdog(answers({ progress: score(0.4) }), makeConfig()).progress).toBe(0.4);
  });

  it("has actionable injection text", () => {
    expect(loopMessage()).toContain("loop");
    expect(verifyMessage()).toContain("verification");
  });
});

describe("evidence-based done check", () => {
  it("recognises verification commands", () => {
    expect(commandIsEvidence("npm test")).toBe(true);
    expect(commandIsEvidence("pnpm run build")).toBe(true);
    expect(commandIsEvidence("pytest -q")).toBe(true);
    expect(commandIsEvidence("git status")).toBe(false);
  });

  it("recognises completion claims", () => {
    expect(claimsCompletion("Done — the feature is implemented.")).toBe(true);
    expect(claimsCompletion("All set.")).toBe(true);
    expect(claimsCompletion("I am still investigating.")).toBe(false);
  });
});

describe("turn summaries", () => {
  it("builds a local summary from text, tool names and errors", () => {
    const message = {
      content: [
        { type: "text", text: "I will run the tests." },
        { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
      ],
    };
    const toolResults = [{ isError: true, content: [{ type: "text", text: "TypeError: x is not a function" }] }];
    const summary = summariseTurn(message, toolResults);
    expect(summary.summary).toContain("I will run the tests.");
    expect(summary.tools_used).toEqual(["bash"]);
    expect(summary.errors[0]).toContain("TypeError");
  });

  it("extracts the first line and caps it", () => {
    expect(firstLine("a\nb")).toBe("a");
    expect(firstLine("x".repeat(200)).endsWith("…")).toBe(true);
    expect(errorLines([{ isError: false, content: [{ type: "text", text: "ok" }] }])).toEqual([]);
  });
});
