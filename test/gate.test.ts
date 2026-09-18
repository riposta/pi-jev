import { describe, expect, it } from "vitest";
import {
  confirmMessage,
  decideGate,
  describeToolInput,
  enforceBlockPolicy,
  isSkippedCommand,
  isSkippedTool,
  normaliseCommand,
  type GateAnswers,
} from "../src/modules/gate.ts";
import { DEFAULT_SKIP_COMMANDS } from "../src/config.ts";
import { makeConfig, noul, score } from "./helpers.ts";

function answers(patch: Partial<GateAnswers> = {}): GateAnswers {
  return {
    blast_radius: score(0.5, 0.9),
    reversible: noul(0.9),
    touches_secrets: noul(0.1),
    matches_intent: noul(0.9),
    exfiltrates: noul(0.1),
    unverified_code: noul(0.1),
    ...patch,
  } as GateAnswers;
}

describe("gate decision table (SDD 9.4)", () => {
  it("row 1: blocks unverified remote code above 0.80", () => {
    expect(decideGate(answers({ unverified_code: noul(0.81) }), makeConfig())).toMatchObject({ outcome: "block", rule: 1 });
    // boundary: exactly 0.80 is not above
    expect(decideGate(answers({ unverified_code: noul(0.8) }), makeConfig()).rule).toBe(7);
  });

  it("row 2: blocks a production blast radius that is irreversible", () => {
    expect(decideGate(answers({ blast_radius: score(3.0), reversible: noul(0.2) }), makeConfig())).toMatchObject({
      outcome: "block",
      rule: 2,
    });
    // boundary: reversible exactly 0.30 is not below
    expect(decideGate(answers({ blast_radius: score(3.0), reversible: noul(0.3) }), makeConfig()).rule).toBe(4);
    // boundary: blast 2.9 is not at the block line
    expect(decideGate(answers({ blast_radius: score(2.9), reversible: noul(0.1) }), makeConfig()).rule).toBe(4);
  });

  it("row 3: confirms drift from the original request", () => {
    expect(decideGate(answers({ matches_intent: noul(0.39) }), makeConfig())).toMatchObject({ outcome: "confirm", rule: 3 });
    expect(decideGate(answers({ matches_intent: noul(0.4) }), makeConfig()).rule).toBe(7);
  });

  it("row 4: confirms a shared-resource blast radius", () => {
    expect(decideGate(answers({ blast_radius: score(2.0) }), makeConfig())).toMatchObject({ outcome: "confirm", rule: 4 });
    expect(decideGate(answers({ blast_radius: score(1.9) }), makeConfig()).rule).toBe(7);
  });

  it("row 4: confirms a non-reversible change beyond scratch files", () => {
    expect(decideGate(answers({ blast_radius: score(1.2), reversible: noul(0.5) }), makeConfig())).toMatchObject({
      outcome: "confirm",
      rule: 4,
    });
    // reversible enough: fall through
    expect(decideGate(answers({ blast_radius: score(1.2), reversible: noul(0.8) }), makeConfig()).rule).toBe(7);
    // still within scratch files: fall through
    expect(decideGate(answers({ blast_radius: score(0.7), reversible: noul(0.2) }), makeConfig()).rule).toBe(7);
  });

  it("row 5: confirms secrets and exfiltration", () => {
    expect(decideGate(answers({ touches_secrets: noul(0.61) }), makeConfig()).rule).toBe(5);
    expect(decideGate(answers({ exfiltrates: noul(0.9) }), makeConfig()).rule).toBe(5);
    expect(decideGate(answers({ touches_secrets: noul(0.6) }), makeConfig()).rule).toBe(7);
  });

  it("row 6: confirms when the blast radius answer is uncertain", () => {
    expect(decideGate(answers({ blast_radius: score(1.0, 0.49) }), makeConfig())).toMatchObject({ outcome: "confirm", rule: 6 });
    expect(decideGate(answers({ blast_radius: score(1.0, 0.5) }), makeConfig()).rule).toBe(7);
  });

  it("row 7: allows everything within thresholds", () => {
    expect(decideGate(answers(), makeConfig())).toMatchObject({ outcome: "allow", rule: 7 });
  });

  it("takes the first matching row", () => {
    const decision = decideGate(answers({ unverified_code: noul(0.95), blast_radius: score(3.0), reversible: noul(0.1) }), makeConfig());
    expect(decision.rule).toBe(1);
  });
});

describe("block policy", () => {
  it("downgrades a disabled block to confirm rather than allow", () => {
    const decision = { outcome: "block" as const, rule: 1, reason: "x", numbers: {} };
    expect(enforceBlockPolicy(decision, false).outcome).toBe("confirm");
    expect(enforceBlockPolicy(decision, true).outcome).toBe("block");
  });
});

describe("pre-flight skips", () => {
  it("skips pure read-only commands", () => {
    expect(isSkippedCommand("git status", DEFAULT_SKIP_COMMANDS)).toBe(true);
    expect(isSkippedCommand("git diff --stat", DEFAULT_SKIP_COMMANDS)).toBe(true);
    expect(isSkippedCommand("npm test -- --watch=false", DEFAULT_SKIP_COMMANDS)).toBe(true);
  });

  it("never skips when the shell can write, chain or substitute", () => {
    expect(isSkippedCommand("git status && rm -rf /", DEFAULT_SKIP_COMMANDS)).toBe(false);
    expect(isSkippedCommand("cat /etc/passwd > out.txt", DEFAULT_SKIP_COMMANDS)).toBe(false);
    expect(isSkippedCommand("echo $(rm -rf /)", DEFAULT_SKIP_COMMANDS)).toBe(false);
    expect(isSkippedCommand("git push --force", DEFAULT_SKIP_COMMANDS)).toBe(false);
  });

  it("skips read-only tools", () => {
    expect(isSkippedTool("read", ["read", "ls", "grep", "find"])).toBe(true);
    expect(isSkippedTool("bash", ["read", "ls", "grep", "find"])).toBe(false);
  });
});

describe("command normalisation", () => {
  it("masks paths and numeric literals so repeats share a cache key", () => {
    expect(normaliseCommand("git log -5")).toBe("git log -N");
    expect(normaliseCommand("git log -10")).toBe("git log -N");
    expect(normaliseCommand("cat /Users/alice/project/file.txt")).toBe("cat <path>");
    expect(normaliseCommand("ls   /home/bob/x")).toBe("ls <path>");
  });
});

describe("describing tool input", () => {
  it("uses the command for shell tools", () => {
    expect(describeToolInput("bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("uses the path for write and edit", () => {
    expect(describeToolInput("edit", { path: "src/a.ts", oldText: "a", newText: "b" })).toContain("src/a.ts");
  });
});

describe("confirm message", () => {
  it("carries the reason, the driving number and the command", () => {
    const decision = decideGate({ ...answers(), blast_radius: score(3.2, 0.8) } as GateAnswers, makeConfig());
    const message = confirmMessage(decision, "git push --force origin main");
    expect(message).toContain("blast radius 3.2/3");
    expect(message).toContain("git push --force origin main");
    expect(message).toContain("Allow?");
  });
});
