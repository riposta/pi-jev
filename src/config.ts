/**
 * config.ts — schema, defaults, resolution and validation.
 *
 * Resolution order (initial_plan.md §12): built-in defaults -> ~/.pi/agent/jev.json ->
 * .pi/jev.json (only when the project is trusted) -> environment overrides.
 *
 * An invalid file raises `ConfigError`, which index.ts turns into "the
 * extension does not load, Pi runs normally". We never fall back silently:
 * silently ignoring a typo in a threshold is exactly the failure this project
 * exists to avoid.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type {
  Config,
  GateConfig,
  ModulesConfig,
  PruneConfig,
  RouterConfig,
  ShieldConfig,
  WatchdogConfig,
} from "./types.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Read-only shell commands that never need classification (initial_plan.md §6.4). */
export const DEFAULT_SKIP_COMMANDS: readonly string[] = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git remote",
  "git rev-parse",
  "git describe",
  "git blame",
  "git fetch",
  "git worktree list",
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "which",
  "whoami",
  "echo",
  "printf",
  "node --version",
  "npm ls",
  "npm test",
  "pnpm test",
  "yarn test",
  "bun test",
  "npm run lint",
  "npm run typecheck",
  "pnpm run lint",
  "pnpm run typecheck",
  "npx vitest",
  "vitest",
  "jest",
  "pytest",
  "go test",
  "cargo test",
  "cargo check",
  "tsc --noEmit",
  "eslint",
];

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

function defaultRouter(): RouterConfig {
  return {
    enabled: true,
    shadow: true,
    // Defaults raised from the initial plan's 800 ms after calibration: measured
    // api.typesafe.ai latency here was p50 673 ms / p95 1752 ms, so 800 ms
    // timed out on most calls and the three-strike rule disabled the hook.
    timeoutMs: 2500,
    confidenceFloor: 0.4,
    clarifyThreshold: 0.7,
    readOnlyThreshold: 0.2,
    sensitiveThreshold: 0.6,
    reasoningBumpScore: 1.6,
    reasoningDropScore: 0,
    reasoningConfidenceFloor: 0,
    skillRouting: false,
    skillSuggestion: false,
    skillsDirs: [],
    thinkingBands: [
      { max: 0.75, level: "off" },
      { max: 1.5, level: "low" },
      { max: 3, level: "high" },
    ],
    tiers: {
      cheap: { provider: "anthropic", model: "claude-haiku-4-5", thinking: "off" },
      standard: { provider: "anthropic", model: "claude-sonnet-5", thinking: "low" },
      strong: { provider: "anthropic", model: "claude-opus-5", thinking: "high" },
    },
  };
}

function defaultGate(): GateConfig {
  return {
    enabled: true,
    shadow: true,
    // On the critical path, but 400 ms measured below p50 and made the gate
    // inert. 2000 ms covers the measured p95 of a single classification.
    timeoutMs: 2000,
    allowBlock: false,
    onFailure: "allow",
    withoutUi: "deny",
    confirmMode: "ask",
    // Obvious cases (force push, recursive rm, DROP) are decided in code, so
    // the gate works offline and does not pay Jev to recognize them.
    fastPath: { enabled: true, block: false },
    rules: {
      enabled: false,
      files: ["AGENTS.md", "CLAUDE.md", ".pi/rules.md", "pi-jev.md"],
      maxRules: 10,
      violationThreshold: 0.6,
      onViolation: "steer",
    },
    thresholds: {
      blockBlastRadius: 3.0,
      blockReversible: 0.3,
      blockUnverifiedCode: 0.8,
      confirmBlastRadius: 2.0,
      confirmIrreversibleBlastRadius: 1.0,
      confirmReversibleFloor: 0.75,
      confirmDriftBlastRadius: 1.0,
      confirmRegenerableThreshold: 0.6,
      confirmInstallsSoftware: 0.6,
      confirmPrivilegedOrRemote: 0.6,
      confirmIntentDrift: 0.4,
      confirmSecrets: 0.6,
      confirmExfiltration: 0.6,
      confidenceFloor: 0.5,
    },
    skipTools: ["read", "ls", "grep", "find"],
    skipCommands: "default",
    diskCache: true,
  };
}

function defaultShield(): ShieldConfig {
  return {
    enabled: true,
    shadow: true,
    timeoutMs: 3000,
    injectionThreshold: 0.7,
    secretThreshold: 0.6,
    personalDataThreshold: 0.6,
    deterministicInjection: true,
  };
}

function defaultPrune(): PruneConfig {
  return {
    enabled: false,
    shadow: true,
    timeoutMs: 3000,
    minLines: 150,
    relevanceThreshold: 0.6,
  };
}

function defaultWatchdog(): WatchdogConfig {
  return {
    enabled: false,
    shadow: true,
    timeoutMs: 2000,
    everyNTurns: 3,
    minTurns: 6,
    loopThreshold: 0.75,
    falseDoneThreshold: 0.7,
    requireEvidence: true,
  };
}

export function defaultConfig(): Config {
  return {
    apiKeyEnv: "TYPESAFE_API_KEY",
    model: "jev-latest",
    baseUrl: "https://api.typesafe.ai",
    budget: {
      maxRequestsPerSession: 200,
      maxTokensPerSession: 400_000,
      onBreach: "disable",
      // TypeSafe's published Jev pricing: $0.042 / MTok input, output free.
      inputPricePerMTok: 0.042,
      outputPricePerMTok: 0,
    },
    residency: {
      enabled: false,
      allowedModels: [],
      allowedRepos: [],
    },
    redaction: {
      patterns: "default",
      maxStateChars: 120_000,
      // 32k tokens is Jev's `state + longest question` ceiling; 32k * ~4 chars
      // is the equivalent character budget.
      maxStateTokens: 32_000,
    },
    modules: {
      router: defaultRouter(),
      gate: defaultGate(),
      shield: defaultShield(),
      prune: defaultPrune(),
      watchdog: defaultWatchdog(),
    },
    telemetry: {
      enabled: true,
      dir: ".pi/jev-log",
      logProbabilities: true,
      logStateHash: true,
      logStateContent: false,
    },
  };
}

/** Runtime timeouts per request class, used by the client. */
export function timeouts(config: Config): Record<"router" | "gate" | "shield_prune" | "watchdog", number> {
  return {
    router: config.modules.router.timeoutMs,
    gate: config.modules.gate.timeoutMs,
    // shield and prune share one request; the larger budget wins.
    shield_prune: Math.max(config.modules.shield.timeoutMs, config.modules.prune.timeoutMs),
    watchdog: config.modules.watchdog.timeoutMs,
  };
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

export interface LoadConfigOptions {
  cwd: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  trusted?: boolean;
  /** Pi's config directory name, `CONFIG_DIR_NAME`. Defaults to ".pi". */
  configDirName?: string;
  /** Injectable for tests. Returns undefined when the file does not exist. */
  readFile?: (path: string) => string | undefined;
  /** Injectable for tests; defaults to the real filesystem. */
  readFileSyncImpl?: (path: string, encoding: "utf8") => string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keys that must never be merged from parsed JSON (prototype pollution). */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Recursive merge. Objects merge, arrays and primitives replace. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (Array.isArray(override)) return override as unknown as T;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || UNSAFE_KEYS.has(key)) continue;
    // Own-property check: never recurse into (and mutate) inherited prototype
    // members such as `toString`.
    out[key] = Object.hasOwn(out, key) ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

function parseJsonFile(read: (path: string) => string | undefined, path: string): unknown {
  const raw = read(path);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new ConfigError(`Expected a boolean environment value, got "${value}"`);
}

function envNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ConfigError(`Expected a number for ${name}, got "${value}"`);
  return parsed;
}

function applyEnv(config: Config, env: NodeJS.ProcessEnv): Config {
  const next = config;
  if (env.PI_JEV_MODEL) next.model = env.PI_JEV_MODEL;
  if (env.PI_JEV_BASE_URL) next.baseUrl = env.PI_JEV_BASE_URL;
  if (env.PI_JEV_API_KEY_ENV) next.apiKeyEnv = env.PI_JEV_API_KEY_ENV;
  if (env.PI_JEV_LOG_DIR) next.telemetry.dir = env.PI_JEV_LOG_DIR;
  const logStateContent = envBool(env.PI_JEV_LOG_STATE_CONTENT);
  if (logStateContent !== undefined) next.telemetry.logStateContent = logStateContent;
  const off = envBool(env.PI_JEV_OFF);
  if (off) {
    for (const module of Object.values(next.modules)) module.enabled = false;
  }
  for (const name of ["router", "gate", "shield", "prune", "watchdog"] as const) {
    const enabled = envBool(env[`PI_JEV_${name.toUpperCase()}_ENABLED`]);
    if (enabled !== undefined) next.modules[name].enabled = enabled;
    const shadow = envBool(env[`PI_JEV_${name.toUpperCase()}_SHADOW`]);
    if (shadow !== undefined) next.modules[name].shadow = shadow;
    const timeout = envNumber(env[`PI_JEV_${name.toUpperCase()}_TIMEOUT_MS`], `PI_JEV_${name.toUpperCase()}_TIMEOUT_MS`);
    if (timeout !== undefined) next.modules[name].timeoutMs = timeout;
  }
  const fastPath = envBool(env.PI_JEV_GATE_FASTPATH_ENABLED);
  if (fastPath !== undefined) next.modules.gate.fastPath.enabled = fastPath;
  const rules = envBool(env.PI_JEV_GATE_RULES_ENABLED);
  if (rules !== undefined) next.modules.gate.rules.enabled = rules;
  const requireEvidence = envBool(env.PI_JEV_WATCHDOG_REQUIRE_EVIDENCE);
  if (requireEvidence !== undefined) next.modules.watchdog.requireEvidence = requireEvidence;
  const maxRequests = envNumber(env.PI_JEV_MAX_REQUESTS, "PI_JEV_MAX_REQUESTS");
  if (maxRequests !== undefined) next.budget.maxRequestsPerSession = maxRequests;
  const maxTokens = envNumber(env.PI_JEV_MAX_TOKENS, "PI_JEV_MAX_TOKENS");
  if (maxTokens !== undefined) next.budget.maxTokensPerSession = maxTokens;
  return next;
}

/** Resolves the config from defaults, files and environment, then validates it. */
export function loadConfig(options: LoadConfigOptions): Config {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const read =
    options.readFile ??
    ((path: string): string | undefined => {
      const impl = options.readFileSyncImpl ?? readFileSync;
      try {
        return impl(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    });

  let config = defaultConfig();
  const userPath = join(home, ".pi", "agent", "jev.json");
  const projectPath = join(options.cwd, options.configDirName ?? ".pi", "jev.json");

  config = deepMerge(config, parseJsonFile(read, userPath));
  if (options.trusted) {
    config = deepMerge(config, parseJsonFile(read, projectPath));
  }
  config = applyEnv(config, env);

  validateConfig(config);
  return config;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function num(value: unknown, path: string, min: number, max = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${path} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${path} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be a boolean`);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value;
}

function validateRouter(router: RouterConfig): void {
  bool(router.enabled, "modules.router.enabled");
  bool(router.shadow, "modules.router.shadow");
  num(router.timeoutMs, "modules.router.timeoutMs", 1);
  num(router.confidenceFloor, "modules.router.confidenceFloor", 0, 1);
  num(router.clarifyThreshold, "modules.router.clarifyThreshold", 0, 1);
  num(router.readOnlyThreshold, "modules.router.readOnlyThreshold", 0, 1);
  num(router.sensitiveThreshold, "modules.router.sensitiveThreshold", 0, 1);
  num(router.reasoningBumpScore, "modules.router.reasoningBumpScore", 0, 3);
  num(router.reasoningDropScore, "modules.router.reasoningDropScore", 0, 3);
  num(router.reasoningConfidenceFloor, "modules.router.reasoningConfidenceFloor", 0, 1);
  bool(router.skillRouting, "modules.router.skillRouting");
  bool(router.skillSuggestion, "modules.router.skillSuggestion");
  if (!Array.isArray(router.skillsDirs) || router.skillsDirs.some((entry) => typeof entry !== "string")) {
    throw new ConfigError("modules.router.skillsDirs must be an array of strings");
  }
  if (!Array.isArray(router.thinkingBands) || router.thinkingBands.length === 0) {
    throw new ConfigError("modules.router.thinkingBands must be a non-empty array");
  }
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  let previousMax = -Infinity;
  for (const [index, band] of router.thinkingBands.entries()) {
    num(band.max, `modules.router.thinkingBands[${index}].max`, 0);
    if (band.max <= previousMax) {
      throw new ConfigError("modules.router.thinkingBands must be ordered by increasing max");
    }
    previousMax = band.max;
    if (!levels.includes(band.level)) {
      throw new ConfigError(`modules.router.thinkingBands[${index}].level must be one of ${levels.join(", ")}`);
    }
  }
  for (const tier of ["cheap", "standard", "strong"] as const) {
    const entry = router.tiers?.[tier];
    if (!entry) throw new ConfigError(`modules.router.tiers.${tier} is required`);
    nonEmptyString(entry.provider, `modules.router.tiers.${tier}.provider`);
    nonEmptyString(entry.model, `modules.router.tiers.${tier}.model`);
    if (!levels.includes(entry.thinking)) {
      throw new ConfigError(`modules.router.tiers.${tier}.thinking must be one of ${levels.join(", ")}`);
    }
  }
}

function validateGate(gate: GateConfig): void {
  bool(gate.enabled, "modules.gate.enabled");
  bool(gate.shadow, "modules.gate.shadow");
  num(gate.timeoutMs, "modules.gate.timeoutMs", 1);
  bool(gate.allowBlock, "modules.gate.allowBlock");
  if (!["allow", "deny"].includes(gate.onFailure)) {
    throw new ConfigError('modules.gate.onFailure must be "allow" or "deny"');
  }
  if (!["deny", "allow-with-log"].includes(gate.withoutUi)) {
    throw new ConfigError('modules.gate.withoutUi must be "deny" or "allow-with-log"');
  }
  if (!["ask", "steer"].includes(gate.confirmMode)) {
    throw new ConfigError('modules.gate.confirmMode must be "ask" or "steer"');
  }
  bool(gate.fastPath.enabled, "modules.gate.fastPath.enabled");
  bool(gate.fastPath.block, "modules.gate.fastPath.block");
  bool(gate.rules.enabled, "modules.gate.rules.enabled");
  if (!Array.isArray(gate.rules.files) || gate.rules.files.some((entry) => typeof entry !== "string")) {
    throw new ConfigError("modules.gate.rules.files must be an array of strings");
  }
  num(gate.rules.maxRules, "modules.gate.rules.maxRules", 0, 255);
  num(gate.rules.violationThreshold, "modules.gate.rules.violationThreshold", 0, 1);
  if (!["steer", "confirm", "block"].includes(gate.rules.onViolation)) {
    throw new ConfigError('modules.gate.rules.onViolation must be "steer", "confirm" or "block"');
  }
  const t = gate.thresholds;
  num(t.blockBlastRadius, "modules.gate.thresholds.blockBlastRadius", 0, 4);
  num(t.blockReversible, "modules.gate.thresholds.blockReversible", 0, 1);
  num(t.blockUnverifiedCode, "modules.gate.thresholds.blockUnverifiedCode", 0, 1);
  num(t.confirmBlastRadius, "modules.gate.thresholds.confirmBlastRadius", 0, 4);
  num(t.confirmIrreversibleBlastRadius, "modules.gate.thresholds.confirmIrreversibleBlastRadius", 0, 4);
  num(t.confirmReversibleFloor, "modules.gate.thresholds.confirmReversibleFloor", 0, 1);
  num(t.confirmDriftBlastRadius, "modules.gate.thresholds.confirmDriftBlastRadius", 0, 4);
  num(t.confirmRegenerableThreshold, "modules.gate.thresholds.confirmRegenerableThreshold", 0, 1);
  num(t.confirmInstallsSoftware, "modules.gate.thresholds.confirmInstallsSoftware", 0, 1);
  num(t.confirmPrivilegedOrRemote, "modules.gate.thresholds.confirmPrivilegedOrRemote", 0, 1);
  num(t.confirmIntentDrift, "modules.gate.thresholds.confirmIntentDrift", 0, 1);
  num(t.confirmSecrets, "modules.gate.thresholds.confirmSecrets", 0, 1);
  num(t.confirmExfiltration, "modules.gate.thresholds.confirmExfiltration", 0, 1);
  num(t.confidenceFloor, "modules.gate.thresholds.confidenceFloor", 0, 1);
  if (!Array.isArray(gate.skipTools)) throw new ConfigError("modules.gate.skipTools must be an array");
  if (gate.skipCommands !== "default" && !Array.isArray(gate.skipCommands)) {
    throw new ConfigError('modules.gate.skipCommands must be "default" or an array');
  }
  bool(gate.diskCache, "modules.gate.diskCache");
}

function validateShield(shield: ShieldConfig): void {
  bool(shield.enabled, "modules.shield.enabled");
  bool(shield.shadow, "modules.shield.shadow");
  num(shield.timeoutMs, "modules.shield.timeoutMs", 1);
  num(shield.injectionThreshold, "modules.shield.injectionThreshold", 0, 1);
  num(shield.secretThreshold, "modules.shield.secretThreshold", 0, 1);
  num(shield.personalDataThreshold, "modules.shield.personalDataThreshold", 0, 1);
  bool(shield.deterministicInjection, "modules.shield.deterministicInjection");
}

function validatePrune(prune: PruneConfig): void {
  bool(prune.enabled, "modules.prune.enabled");
  bool(prune.shadow, "modules.prune.shadow");
  num(prune.timeoutMs, "modules.prune.timeoutMs", 1);
  num(prune.minLines, "modules.prune.minLines", 0);
  num(prune.relevanceThreshold, "modules.prune.relevanceThreshold", 0, 1);
}

function validateWatchdog(watchdog: WatchdogConfig): void {
  bool(watchdog.enabled, "modules.watchdog.enabled");
  bool(watchdog.shadow, "modules.watchdog.shadow");
  num(watchdog.timeoutMs, "modules.watchdog.timeoutMs", 1);
  num(watchdog.everyNTurns, "modules.watchdog.everyNTurns", 1);
  num(watchdog.minTurns, "modules.watchdog.minTurns", 0);
  num(watchdog.loopThreshold, "modules.watchdog.loopThreshold", 0, 1);
  num(watchdog.falseDoneThreshold, "modules.watchdog.falseDoneThreshold", 0, 1);
  bool(watchdog.requireEvidence, "modules.watchdog.requireEvidence");
}

export function validateConfig(config: Config): void {
  nonEmptyString(config.apiKeyEnv, "apiKeyEnv");
  nonEmptyString(config.model, "model");
  nonEmptyString(config.baseUrl, "baseUrl");
  try {
    // eslint-disable-next-line no-new
    new URL(config.baseUrl);
  } catch {
    throw new ConfigError(`baseUrl must be a valid URL, got "${config.baseUrl}"`);
  }
  num(config.budget.maxRequestsPerSession, "budget.maxRequestsPerSession", 0);
  num(config.budget.maxTokensPerSession, "budget.maxTokensPerSession", 0);
  num(config.budget.inputPricePerMTok, "budget.inputPricePerMTok", 0);
  num(config.budget.outputPricePerMTok, "budget.outputPricePerMTok", 0);
  if (!["disable", "warn"].includes(config.budget.onBreach)) {
    throw new ConfigError('budget.onBreach must be "disable" or "warn"');
  }
  bool(config.residency.enabled, "residency.enabled");
  for (const key of ["allowedModels", "allowedRepos"] as const) {
    const list = config.residency[key];
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new ConfigError(`residency.${key} must be an array of non-empty strings`);
    }
  }
  for (const [key, value] of Object.entries(config.modules)) {
    if (!isPlainObject(value)) throw new ConfigError(`modules.${key} must be an object`);
  }
  validateRouter(config.modules.router);
  validateGate(config.modules.gate);
  validateShield(config.modules.shield);
  validatePrune(config.modules.prune);
  validateWatchdog(config.modules.watchdog);
  num(config.redaction.maxStateChars, "redaction.maxStateChars", 1);
  num(config.redaction.maxStateTokens, "redaction.maxStateTokens", 1);
  const patterns = config.redaction.patterns;
  const custom = isPlainObject(patterns) ? (patterns as { custom?: unknown }).custom : undefined;
  const validCustom = Array.isArray(custom) && custom.every((entry) => typeof entry === "string");
  if (patterns !== "default" && patterns !== "strict" && typeof patterns !== "string" && !validCustom) {
    throw new ConfigError('redaction.patterns must be "default", "strict", a file path, or { custom: string[] }');
  }
  bool(config.telemetry.enabled, "telemetry.enabled");
  nonEmptyString(config.telemetry.dir, "telemetry.dir");
  bool(config.telemetry.logProbabilities, "telemetry.logProbabilities");
  bool(config.telemetry.logStateHash, "telemetry.logStateHash");
  bool(config.telemetry.logStateContent, "telemetry.logStateContent");
}

/** Effective allowlist used by the gate; exported so the tests read the same list. */
export function effectiveSkipCommands(gate: GateConfig): readonly string[] {
  return gate.skipCommands === "default" ? DEFAULT_SKIP_COMMANDS : gate.skipCommands;
}

/** Resolves `redaction.patterns` to a list of extra regex sources. */
export function resolveCustomPatterns(config: Config, cwd: string): string[] {
  const patterns = config.redaction.patterns;
  if (Array.isArray(patterns)) return patterns;
  // The documented inline shape. Validation guarantees the entries are strings.
  if (isPlainObject(patterns) && Array.isArray((patterns as { custom?: unknown }).custom)) {
    return (patterns as { custom: string[] }).custom;
  }
  if (typeof patterns === "string" && patterns !== "default" && patterns !== "strict") {
    const path = isAbsolute(patterns) ? patterns : join(cwd, patterns);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) return parsed;
      throw new ConfigError(`Custom redaction patterns in ${path} must be a JSON array of strings`);
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(`Could not read custom redaction patterns at ${path}: ${(error as Error).message}`);
    }
  }
  return [];
}

/** Returns the modules that are enabled, in a stable order. */
export function enabledModules(config: Config): (keyof ModulesConfig)[] {
  return (["router", "gate", "shield", "prune", "watchdog"] as const).filter(
    (name) => config.modules[name].enabled,
  );
}
