import { describe, expect, it } from "vitest";
import {
  evaluateShield,
  maskContent,
  resultText,
  sampleToolOutput,
  shieldHasMasking,
  withheldNotice,
  type ShieldAnswers,
} from "../src/modules/shield.ts";
import { createRedactor } from "../src/redact.ts";
import { choice, makeConfig, noul, score } from "./helpers.ts";

function answers(patch: Partial<ShieldAnswers> = {}): ShieldAnswers {
  return {
    has_injection: noul(0.05),
    has_secret: noul(0.05),
    has_personal_data: noul(0.05),
    failure_type: choice("none"),
    ...patch,
  } as ShieldAnswers;
}

describe("shield decision", () => {
  it("replaces content carrying instructions above the injection threshold", () => {
    expect(evaluateShield(answers({ has_injection: noul(0.71) }), makeConfig()).replace).toBe(true);
    expect(evaluateShield(answers({ has_injection: noul(0.7) }), makeConfig()).replace).toBe(false);
  });

  it("masks secrets and personal data without replacing", () => {
    const decision = evaluateShield(answers({ has_secret: noul(0.9), has_personal_data: noul(0.8) }), makeConfig());
    expect(decision.replace).toBe(false);
    expect(shieldHasMasking(decision)).toBe(true);
    expect(decision.reasons).toHaveLength(2);
  });

  it("names the tool and the reason in the withheld notice", () => {
    const decision = evaluateShield(answers({ has_injection: noul(0.99) }), makeConfig());
    expect(withheldNotice("read", decision)).toContain("read");
    expect(withheldNotice("read", decision)).toContain("prompt injection");
  });

  it("masks every text block", () => {
    const redact = createRedactor();
    const masked = maskContent(
      [
        { type: "text", text: "alice@example.com" },
        { type: "image", data: "ignored" },
      ],
      redact,
    );
    expect(masked).toEqual([{ type: "text", text: "[redacted email]" }]);
  });
});

describe("sampling", () => {
  it("passes small outputs through unchanged", () => {
    expect(sampleToolOutput("a\nb\nc").droppedLines).toBe(0);
    expect(sampleToolOutput("a\nb\nc").text).toBe("a\nb\nc");
  });

  it("keeps head and tail and marks what was dropped", () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `line ${index}`);
    const sampled = sampleToolOutput(lines.join("\n"));
    expect(sampled.totalLines).toBe(1000);
    expect(sampled.droppedLines).toBeGreaterThan(0);
    expect(sampled.text).toContain("line 0\n");
    expect(sampled.text).toContain("line 999");
    expect(sampled.text).toContain("[pi-jev:");
  });

  it("joins text content for classification", () => {
    expect(resultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });
});
