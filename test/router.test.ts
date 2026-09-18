import { describe, expect, it } from "vitest";
import { decideRouter, restrictToAllowed, thinkingFor, type RouterAnswers } from "../src/modules/router.ts";
import { choice, makeConfig, noul, score } from "./helpers.ts";

function answers(patch: Partial<RouterAnswers> = {}): RouterAnswers {
  return {
    task_type: choice("feature", 0.9),
    reasoning_needed: score(1.2, 0.9),
    scope: choice("few_files"),
    is_underspecified: noul(0.1),
    needs_write_tools: noul(0.9),
    touches_sensitive: noul(0.1),
    domain: choice("backend"),
    ...patch,
  } as RouterAnswers;
}

describe("router decision", () => {
  it("maps mechanical and question tasks to the cheap tier", () => {
    expect(decideRouter(answers({ task_type: choice("trivial_edit"), reasoning_needed: score(0.2) }), makeConfig()).tier).toBe("cheap");
    expect(decideRouter(answers({ task_type: choice("question"), reasoning_needed: score(0.2) }), makeConfig()).tier).toBe("cheap");
  });

  it("maps features to standard and architecture to strong", () => {
    expect(decideRouter(answers({ task_type: choice("feature"), reasoning_needed: score(1.2) }), makeConfig()).tier).toBe("standard");
    expect(decideRouter(answers({ task_type: choice("architecture"), reasoning_needed: score(1.2) }), makeConfig()).tier).toBe("strong");
  });

  it("bumps a tier when deep reasoning is needed", () => {
    const decision = decideRouter(answers({ task_type: choice("feature"), reasoning_needed: score(2.2, 0.9) }), makeConfig());
    expect(decision.tier).toBe("strong");
  });

  it("drops a tier for purely mechanical reasoning without going below cheap", () => {
    expect(decideRouter(answers({ task_type: choice("feature"), reasoning_needed: score(0.3, 0.9) }), makeConfig()).tier).toBe("cheap");
    expect(decideRouter(answers({ task_type: choice("question"), reasoning_needed: score(0.1, 0.9) }), makeConfig()).tier).toBe("cheap");
  });

  it("escalates, never downgrades, on low confidence (P4)", () => {
    const decision = decideRouter(answers({ reasoning_needed: score(1.2, 0.3) }), makeConfig());
    expect(decision.tier).toBe("strong");
    expect(decision.signals.low_confidence).toContain("reasoning_needed");
  });

  it("restricts the tier to the residency allowlist and never widens it", () => {
    const config = makeConfig({ residency: { enabled: true, allowedModels: ["claude-sonnet-5"] } });
    const decision = decideRouter(answers({ task_type: choice("architecture"), touches_sensitive: noul(0.9) }), config);
    expect(decision.tier).toBe("standard");
    expect(decision.restricted).toBe(true);
  });

  it("ignores the residency allowlist when disabled", () => {
    const config = makeConfig({ residency: { enabled: false, allowedModels: ["claude-sonnet-5"] } });
    const decision = decideRouter(answers({ task_type: choice("architecture"), touches_sensitive: noul(0.9) }), config);
    expect(decision.tier).toBe("strong");
  });

  it("restricts the tool loadout only when write tools are clearly unnecessary", () => {
    expect(decideRouter(answers({ needs_write_tools: noul(0.05) }), makeConfig()).readOnly).toBe(true);
    // ambiguous: the dead zone must not strip tools
    expect(decideRouter(answers({ needs_write_tools: noul(0.5) }), makeConfig()).readOnly).toBe(false);
    expect(decideRouter(answers({ needs_write_tools: noul(0.9) }), makeConfig()).readOnly).toBe(false);
  });

  it("nudges on underspecification", () => {
    expect(decideRouter(answers({ is_underspecified: noul(0.9) }), makeConfig()).clarify).toBe(true);
    expect(decideRouter(answers({ is_underspecified: noul(0.2) }), makeConfig()).clarify).toBe(false);
  });

  it("derives thinking level from the reasoning bands", () => {
    expect(decideRouter(answers({ reasoning_needed: score(0.2) }), makeConfig()).thinking).toBe("off");
    expect(decideRouter(answers({ reasoning_needed: score(1.2) }), makeConfig()).thinking).toBe("low");
    expect(decideRouter(answers({ reasoning_needed: score(2.5) }), makeConfig()).thinking).toBe("high");
  });
});

describe("router helpers", () => {
  it("orders thinking bands", () => {
    const bands = [
      { max: 1, level: "off" as const },
      { max: 2, level: "low" as const },
      { max: 3, level: "high" as const },
    ];
    expect(thinkingFor(0.5, bands)).toBe("off");
    expect(thinkingFor(1.5, bands)).toBe("low");
    expect(thinkingFor(9, bands)).toBe("high");
  });

  it("restrictToAllowed picks the strongest allowed tier at or below the request", () => {
    const config = makeConfig();
    expect(restrictToAllowed("strong", config, [])).toEqual({ tier: "strong", restricted: false });
    expect(restrictToAllowed("strong", config, ["claude-sonnet-5"])).toEqual({ tier: "standard", restricted: true });
    expect(restrictToAllowed("strong", config, ["claude-haiku-4-5"])).toEqual({ tier: "cheap", restricted: true });
    expect(restrictToAllowed("strong", config, ["claude-opus-5"])).toEqual({ tier: "strong", restricted: false });
  });
});
