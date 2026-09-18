/**
 * tools/evaluate.ts — run the labelled fixtures against Jev and report the
 * acceptance metrics from initial_plan.md §17.4.
 *
 * These numbers are the only ones the README may quote (initial_plan.md §17.5). The fixtures
 * live in the repository so anyone can re-run them.
 *
 * Usage:
 *   node --experimental-strip-types tools/evaluate.ts [fixtures-dir] [--json]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deepMerge, loadConfig } from "../src/config.ts";
import { createClient } from "../src/client.ts";
import { createRedactor } from "../src/redact.ts";
import { GATE_QUESTIONS, ROUTER_QUESTIONS_CORE, SHIELD_QUESTIONS } from "../src/questions.ts";
import { parseJsonl } from "../src/telemetry.ts";
import { decideRouter, type RouterAnswers } from "../src/modules/router.ts";
import { decideGate, enforceBlockPolicy, type GateAnswers } from "../src/modules/gate.ts";
import { evaluateShield as decideShield, type ShieldAnswers } from "../src/modules/shield.ts";
import type { AskFn, Config, HookName, TierName } from "../src/types.ts";

export interface PromptFixture {
  prompt: string;
  tier: TierName;
}

export interface CommandFixture {
  command: string;
  label: "safe" | "confirm" | "dangerous";
  user_request?: string;
}

export interface InjectionFixture {
  text: string;
  injection: boolean;
}

export interface RouterMetric {
  total: number;
  correct: number;
  accuracy: number;
  confusion: Record<string, number>;
  mismatches: Array<{ prompt: string; expected: TierName; got: TierName }>;
  /** Raw answers per fixture, for offline threshold tuning without new calls. */
  items: Array<{ prompt: string; expected: TierName; got: TierName; answers: unknown }>;
}

export interface GateMetric {
  dangerous: number;
  falseNegatives: number;
  safe: number;
  falsePositives: number;
  falsePositiveRate: number;
  confirms: number;
  items: Array<{ command: string; label: string; outcome: string; rule: number; numbers: Record<string, number> }>;
}

export interface ShieldMetric {
  positives: number;
  detected: number;
  detectionRate: number;
  negatives: number;
  falsePositives: number;
  items: Array<{ text: string; injection: boolean; replace: boolean; injectionScore: number }>;
}

export async function evaluateRouter(
  fixtures: readonly PromptFixture[],
  ask: AskFn,
  config: Config,
): Promise<RouterMetric> {
  const metric: RouterMetric = { total: 0, correct: 0, accuracy: 0, confusion: {}, mismatches: [], items: [] };
  for (const fixture of fixtures) {
    const result = await ask("router", { prompt: fixture.prompt, cwd_basename: "repo", recent_files: [], previous_turn: "", available_tiers: [] }, ROUTER_QUESTIONS_CORE);
    if (!result) continue;
    const decision = decideRouter(result.answers as RouterAnswers, config);
    metric.total += 1;
    metric.items.push({ prompt: fixture.prompt, expected: fixture.tier, got: decision.tier, answers: result.answers });
    if (decision.tier === fixture.tier) metric.correct += 1;
    else metric.mismatches.push({ prompt: fixture.prompt, expected: fixture.tier, got: decision.tier });
    const key = `${fixture.tier}->${decision.tier}`;
    metric.confusion[key] = (metric.confusion[key] ?? 0) + 1;
  }
  metric.accuracy = metric.total > 0 ? metric.correct / metric.total : Number.NaN;
  return metric;
}

export async function evaluateGate(
  fixtures: readonly CommandFixture[],
  ask: AskFn,
  config: Config,
): Promise<GateMetric> {
  // Measure the table as if block were enabled, so false negatives are not
  // masked by the v1 default of block-off.
  const strict = deepMerge(config, { modules: { gate: { allowBlock: true } } });
  const metric: GateMetric = {
    dangerous: 0,
    falseNegatives: 0,
    safe: 0,
    falsePositives: 0,
    falsePositiveRate: Number.NaN,
    confirms: 0,
    items: [],
  };
  for (const fixture of fixtures) {
    const result = await ask(
      "gate",
      {
        tool: "bash",
        command: fixture.command,
        cwd_basename: "repo",
        user_request: fixture.user_request ?? "",
        recent_commands: [],
      },
      GATE_QUESTIONS,
      { cacheKey: undefined },
    );
    if (!result) continue;
    const decision = enforceBlockPolicy(decideGate(result.answers as GateAnswers, strict), true);
    metric.items.push({ command: fixture.command, label: fixture.label, outcome: decision.outcome, rule: decision.rule, numbers: decision.numbers });
    if (decision.outcome === "confirm") metric.confirms += 1;
    if (fixture.label === "dangerous") {
      metric.dangerous += 1;
      if (decision.outcome === "allow") metric.falseNegatives += 1;
    } else if (fixture.label === "safe") {
      metric.safe += 1;
      if (decision.outcome !== "allow") metric.falsePositives += 1;
    }
  }
  metric.falsePositiveRate = metric.safe > 0 ? metric.falsePositives / metric.safe : Number.NaN;
  return metric;
}

export async function evaluateShield(
  fixtures: readonly InjectionFixture[],
  ask: AskFn,
  config: Config,
): Promise<ShieldMetric> {
  const metric: ShieldMetric = { positives: 0, detected: 0, detectionRate: Number.NaN, negatives: 0, falsePositives: 0, items: [] };
  for (const fixture of fixtures) {
    const result = await ask("shield_prune", { tool: "read", tool_output: fixture.text, is_error: false, cwd_basename: "repo" }, SHIELD_QUESTIONS);
    if (!result) continue;
    const decision = decideShield({ ...(result.answers as ShieldAnswers), failure_type: { type: "choice", choice: "none", probabilities: {}, confidence: 1 } }, config);
    metric.items.push({ text: fixture.text, injection: fixture.injection, replace: decision.replace, injectionScore: decision.injection });
    if (fixture.injection) {
      metric.positives += 1;
      if (decision.replace) metric.detected += 1;
    } else {
      metric.negatives += 1;
      if (decision.replace) metric.falsePositives += 1;
    }
  }
  metric.detectionRate = metric.positives > 0 ? metric.detected / metric.positives : Number.NaN;
  return metric;
}

export function loadFixtures<T>(path: string): T[] {
  return parseJsonlUnknown(readFileSync(path, "utf8")) as T[];
}

function parseJsonlUnknown(text: string): unknown[] {
  return parseJsonl(text) as unknown[];
}

async function main(argv: string[]): Promise<void> {
  const dir = argv.find((arg) => !arg.startsWith("--")) ?? join(process.cwd(), "fixtures");
  const config = loadConfig({ cwd: process.cwd(), trusted: true });
  const state = {
    layerEnabled: true,
    shadow: { router: true, gate: true, shield: true, prune: true, watchdog: true },
    clientDisabledReason: null,
    disabledHooks: new Set<HookName>(),
    requests: 0,
    tokens: 0,
    costUsd: 0,
    degraded: false,
    last: {},
  };
  const client = createClient({
    config,
    state,
    redact: createRedactor({ patterns: config.redaction.patterns }),
    log: () => {},
    status: () => {},
    cwd: process.cwd(),
  });
  if (!client.hasApiKey) {
    console.error(`evaluate needs an API key in ${config.apiKeyEnv}`);
    process.exit(1);
  }

  const router = await evaluateRouter(loadFixtures<PromptFixture>(join(dir, "prompts.jsonl")), client.ask, config);
  const gate = await evaluateGate(loadFixtures<CommandFixture>(join(dir, "commands.jsonl")), client.ask, config);
  const shield = await evaluateShield(loadFixtures<InjectionFixture>(join(dir, "injections.jsonl")), client.ask, config);
  const report = { router, gate, shield };

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("router");
  console.log(`  tier accuracy: ${(router.accuracy * 100).toFixed(1)}% (${router.correct}/${router.total})`);
  console.log(`  confusion: ${JSON.stringify(router.confusion)}`);
  console.log("gate");
  console.log(`  false negatives on dangerous: ${gate.falseNegatives}/${gate.dangerous}`);
  console.log(`  false positives on safe: ${gate.falsePositives}/${gate.safe} (${(gate.falsePositiveRate * 100).toFixed(1)}%)`);
  console.log(`  confirms: ${gate.confirms}`);
  console.log("shield");
  console.log(`  injection detection: ${shield.detected}/${shield.positives} (${(shield.detectionRate * 100).toFixed(1)}%)`);
  console.log(`  false positives: ${shield.falsePositives}/${shield.negatives}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main(process.argv.slice(2));
}
