import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableModels,
  decideRouter,
  describeModel,
  isAllowedModel,
  loadSkills,
  modelForTier,
  resolveChosenModel,
  resolveChosenSkill,
  restrictToAllowed,
  thinkingFor,
  type ModelInfo,
  type RouterAnswers,
} from "../src/modules/router.ts";
import { choice, makeConfig, noul, score } from "./helpers.ts";

const DEEPSEEK_MODELS: ModelInfo[] = [
  { provider: "deepseek", id: "deepseek-flash", name: "Flash", reasoning: false, contextWindow: 64_000 },
  { provider: "deepseek", id: "deepseek-v4-pro", name: "Pro", reasoning: true, contextWindow: 128_000 },
];

function deepseekTiers() {
  return {
    modules: {
      router: {
        tiers: {
          cheap: { provider: "deepseek", model: "deepseek-flash", thinking: "off" as const },
          standard: { provider: "deepseek", model: "deepseek-v4-pro", thinking: "low" as const },
          strong: { provider: "deepseek", model: "deepseek-v4-pro", thinking: "high" as const },
        },
      },
    },
  };
}

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
    expect(decideRouter(answers({ task_type: choice("feature"), reasoning_needed: score(0, 0.9) }), makeConfig()).tier).toBe("cheap");
    expect(decideRouter(answers({ task_type: choice("question"), reasoning_needed: score(0, 0.9) }), makeConfig()).tier).toBe("cheap");
  });

  it("escalates, never downgrades, on low task confidence (P4)", () => {
    const decision = decideRouter(answers({ task_type: choice("feature", 0.3), reasoning_needed: score(1.2, 0.9) }), makeConfig());
    expect(decision.tier).toBe("strong");
    expect(decision.signals.low_confidence).toContain("task_type");
  });

  it("does not escalate on a diffuse Score confidence by default", () => {
    // Calibration finding: a multi-level Score spreads probability, so its
    // confidence is not comparable to a Choice's. The reasoning floor is 0.
    expect(decideRouter(answers({ reasoning_needed: score(1.2, 0.3) }), makeConfig()).tier).toBe("standard");
  });

  it("escalates on low reasoning confidence when the floor is configured", () => {
    const config = makeConfig({ modules: { router: { reasoningConfidenceFloor: 0.5 } } });
    const decision = decideRouter(answers({ reasoning_needed: score(1.2, 0.3) }), config);
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

describe("available models from Pi", () => {
  it("reads the list from the registry", () => {
    const ctx = {
      modelRegistry: { getAvailable: () => DEEPSEEK_MODELS },
    } as unknown as Parameters<typeof availableModels>[0];
    expect(availableModels(ctx)).toEqual(DEEPSEEK_MODELS);
  });

  it("is empty when the registry has no getAvailable (older Pi or a test fake)", () => {
    const ctx = { modelRegistry: { find: () => undefined } } as unknown as Parameters<typeof availableModels>[0];
    expect(availableModels(ctx)).toEqual([]);
  });

  it("describes a model for the Choice criteria", () => {
    const text = describeModel(DEEPSEEK_MODELS[1] as ModelInfo);
    expect(text).toContain("deepseek/deepseek-v4-pro");
    expect(text).toContain("extended reasoning");
    expect(text).toContain("128k context");
  });
});

describe("classifier model choice", () => {
  it("maps the option key back to a concrete model", () => {
    expect(resolveChosenModel(choice("m1"), DEEPSEEK_MODELS)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    expect(resolveChosenModel(choice("m9"), DEEPSEEK_MODELS)).toBeUndefined();
    expect(resolveChosenModel(choice("other"), DEEPSEEK_MODELS)).toBeUndefined();
    expect(resolveChosenModel(undefined, DEEPSEEK_MODELS)).toBeUndefined();
  });

  it("prefers the classifier's model over the tier map", () => {
    const decision = decideRouter(
      answers({ task_type: choice("trivial_edit"), reasoning_needed: score(0.1) }),
      makeConfig(),
      DEEPSEEK_MODELS,
      choice("m1"),
    );
    expect(decision.tier).toBe("cheap");
    expect(decision.chosenModel).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(decision.signals.chosen_model).toBe("deepseek/deepseek-v4-pro");
  });

  it("falls back to the tier when the classifier did not choose", () => {
    const decision = decideRouter(
      answers({ task_type: choice("trivial_edit"), reasoning_needed: score(0.1) }),
      makeConfig(),
      DEEPSEEK_MODELS,
    );
    expect(decision.tier).toBe("cheap");
    expect(decision.chosenModel).toBeUndefined();
  });

  it("drops a chosen model outside the residency allowlist", () => {
    const config = makeConfig({
      ...deepseekTiers(),
      residency: { enabled: true, allowedModels: ["deepseek-flash"] },
    });
    const decision = decideRouter(
      answers({ touches_sensitive: noul(0.9) }),
      config,
      DEEPSEEK_MODELS,
      choice("m1"),
    );
    expect(decision.chosenModel).toBeUndefined();
    expect(decision.restricted).toBe(true);
  });

  it("keeps a chosen model inside the allowlist", () => {
    const config = makeConfig({
      ...deepseekTiers(),
      residency: { enabled: true, allowedModels: ["deepseek-flash"] },
    });
    const decision = decideRouter(answers({ touches_sensitive: noul(0.9) }), config, DEEPSEEK_MODELS, choice("m0"));
    expect(decision.chosenModel).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  });

  it("checks allowlist membership for a concrete model", () => {
    expect(isAllowedModel({ provider: "deepseek", model: "deepseek-flash" }, ["deepseek-flash"])).toBe(true);
    expect(isAllowedModel({ provider: "deepseek", model: "deepseek-flash" }, ["deepseek/deepseek-flash"])).toBe(true);
    expect(isAllowedModel({ provider: "deepseek", model: "deepseek-flash" }, ["claude-haiku-4-5"])).toBe(false);
  });

  it("resolves the configured tier model", () => {
    expect(modelForTier(makeConfig(), "cheap")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });
});

describe("skill catalog", () => {
  it("loads skills from SKILL.md frontmatter and maps the choice back", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-skills-"));
    mkdirSync(join(dir, "deploy"), { recursive: true });
    writeFileSync(
      join(dir, "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy the service safely.\n---\n\nbody",
    );
    const skills = loadSkills(dir, [dir]);
    expect(skills[0]).toMatchObject({ name: "deploy", description: "Deploy the service safely." });
    expect(resolveChosenSkill(choice("s0"), skills)?.name).toBe("deploy");
    expect(resolveChosenSkill(choice("none"), skills)).toBeUndefined();
    expect(resolveChosenSkill(undefined, skills)).toBeUndefined();
  });

  it("returns no skills for a missing directory", () => {
    expect(loadSkills("/nonexistent", ["/definitely/not/here"])).toEqual([]);
  });
});
