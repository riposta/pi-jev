/**
 * Shared types for pi-jev.
 *
 * This file is intentionally free of runtime logic and of imports from Pi, so
 * that modules and tools can be unit-tested without a running harness.
 */

/* -------------------------------------------------------------------------- */
/* Jev primitives                                                             */
/* -------------------------------------------------------------------------- */

/** A Choice answer: one option plus its distribution. */
export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}

/** A Score answer: a position on the level number line, plus its distribution. */
export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  /** Level number -> description. Raw API keys are strings; we normalise to string keys. */
  readonly legend: Record<string, string>;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}

/** A Noul answer: the probability that the statement is true. No separate confidence. */
export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  /** Ordered levels, low to high. Level numbers are array indices starting at 0. */
  readonly criteria: readonly string[];
}

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: { readonly true: string; readonly false: string };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type QuestionSet = Readonly<Record<string, Question>>;

/** Maps a question definition to the answer type the API returns for it. */
export type AnswerFor<Q> = Q extends { readonly type: "choice" }
  ? ChoiceAnswer
  : Q extends { readonly type: "score" }
    ? ScoreAnswer
    : Q extends { readonly type: "noul" }
      ? NoulAnswer
      : never;

export type Answers<Q extends QuestionSet> = { [K in keyof Q]: AnswerFor<Q[K]> };

/* -------------------------------------------------------------------------- */
/* Modules and hooks                                                          */
/* -------------------------------------------------------------------------- */

export type ModuleName = "router" | "gate" | "shield" | "prune" | "watchdog";

/**
 * A request class, not a module. `shield_prune` is the single request shared by
 * shield and prune on `tool_result` (initial_plan.md §5.4). Timeouts and budgets are keyed by
 * this, so it is also what `ask` receives.
 */
export type HookName = "router" | "gate" | "shield_prune" | "watchdog";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AskMeta {
  hook: HookName;
  model: string;
  /** The versioned model the API reported answering (e.g. `jev-1.13.0`). */
  answeredModel?: string;
  latencyMs: number;
  cached: boolean;
  /** sha256 of the redacted state that was sent. */
  stateHash: string;
  /** Kept for the record; currently a build-time constant. */
  questionsVersion: string;
  usage: TokenUsage;
  /** The redacted state that was sent. Persisted only when logStateContent is on. */
  redactedState: unknown;
}

export interface AskResult<A> {
  answers: A;
  meta: AskMeta;
}

export interface AskOptions {
  signal?: AbortSignal;
  /**
   * Stable key for the gate's on-disk command cache. When present and the hook
   * is `gate`, the client uses the disk cache in addition to the in-memory LRU.
   */
  cacheKey?: string;
  /** Set false to bypass the in-memory LRU (in-flight coalescing still applies). */
  allowCache?: boolean;
}

/**
 * The only way modules talk to TypeSafe. Returns `null` on every failure path
 * (timeout, HTTP error, budget breach, missing key, disabled layer). The client
 * never throws into a hook handler.
 */
export type AskFn = <Q extends QuestionSet>(
  hook: HookName,
  state: unknown,
  questions: Q,
  opts?: AskOptions,
) => Promise<AskResult<Answers<Q>> | null>;

/** Deterministic, pattern-based scrub applied before anything leaves the machine. */
export interface RedactFn {
  (text: string): string;
  /** Walks objects and arrays, redacting every string leaf. */
  deep(value: unknown): unknown;
}

/* -------------------------------------------------------------------------- */
/* Decisions                                                                  */
/* -------------------------------------------------------------------------- */

export type TierName = "cheap" | "standard" | "strong";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RouterDecision {
  tier: TierName;
  thinking: ThinkingLevel;
  /**
   * Concrete model the classifier picked from Pi's available list. Absent when
   * the classifier did not choose (older answer shape, offline fixtures, or a
   * residency override), in which case the tier's configured model is used.
   */
  chosenModel?: { provider: string; model: string };
  /** Restrict the tool loadout to read-only tools for this run. */
  readOnly: boolean;
  /** Append the clarify directive to the system prompt. */
  clarify: boolean;
  /** The residency allowlist narrowed the tier. */
  restricted: boolean;
  /** Human-readable drivers, for telemetry and `/jev explain`. */
  signals: Record<string, number | string>;
}

export type GateOutcome = "allow" | "confirm" | "block";

export interface GateDecision {
  outcome: GateOutcome;
  /** Which row of the decision table fired (1-based) or 0 for the fall-through. */
  rule: number;
  /**
   * Distinguishes branches that share a row number. Rule 4 covers both the
   * shared-resource blast radius and the "irreversible beyond scratch files"
   * case; labelling them apart keeps the per-rule calibration honest.
   */
  branch?: string;
  /** Deliver the concern to the agent instead of prompting the user. */
  steer?: boolean;
  reason: string;
  numbers: Record<string, number>;
}

export interface ShieldDecision {
  /** Replace the tool result content with a neutral notice. */
  replace: boolean;
  reasons: string[];
  injection: number;
  secret: number;
  personalData: number;
}

export interface PruneDecision {
  prune: boolean;
  relevance: number;
}

export interface WatchdogDecision {
  looping: boolean;
  falseDone: boolean;
  progress: number;
  /** Which injection to make, if any. */
  inject: "loop" | "verify" | null;
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

export interface TierConfig {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

export interface ThinkingBand {
  /** Inclusive upper bound of the `reasoning_needed` score for this level. */
  max: number;
  level: ThinkingLevel;
}

export interface RouterConfig {
  enabled: boolean;
  shadow: boolean;
  timeoutMs: number;
  confidenceFloor: number;
  clarifyThreshold: number;
  readOnlyThreshold: number;
  sensitiveThreshold: number;
  /** `reasoning_needed` score at or above which the tier is bumped up by one. */
  reasoningBumpScore: number;
  /** `reasoning_needed` score at or below which the tier is bumped down by one. */
  reasoningDropScore: number;
  /**
   * Confidence floor for the `reasoning_needed` Score. Separate from
   * `confidenceFloor` because a multi-level Score spreads probability, so its
   * confidence is naturally lower than a Choice's. Calibrated on fixtures.
   */
  reasoningConfidenceFloor: number;
  /** When true, `domain` is read for skill routing. Off by default (speculative). */
  skillRouting: boolean;
  /**
   * When true, the router suggests at most one skill from the local skill
   * catalog (`skillsDirs`) instead of only choosing a model.
   */
  skillSuggestion: boolean;
  /** Directories scanned for `SKILL.md` files. Empty means no skill catalog. */
  skillsDirs: string[];
  /** Reasoning score -> thinking level. Ordered, first band whose `max` is not exceeded wins. */
  thinkingBands: ThinkingBand[];
  tiers: Record<TierName, TierConfig>;
}

export interface GateThresholds {
  blockBlastRadius: number;
  blockReversible: number;
  blockUnverifiedCode: number;
  confirmBlastRadius: number;
  /** Confirm when the command is not cleanly reversible and reaches beyond scratch files. */
  confirmIrreversibleBlastRadius: number;
  confirmReversibleFloor: number;
  /** Drift only confirms when the command can change something beyond scratch files. */
  confirmDriftBlastRadius: number;
  /** A command that only refreshes regenerable artefacts never triggers the irreversible confirm. */
  confirmRegenerableThreshold: number;
  /** Confirm when the command installs software from a registry. */
  confirmInstallsSoftware: number;
  /** Confirm when the command escalates privileges or executes on a remote host. */
  confirmPrivilegedOrRemote: number;
  confirmIntentDrift: number;
  confirmSecrets: number;
  confirmExfiltration: number;
  confidenceFloor: number;
}

export type GateFailurePolicy = "allow" | "deny";
export type ConfirmPolicy = "deny" | "allow-with-log";
/** `ask` prompts the user; `steer` sends the concern back to the agent instead. */
export type GateConfirmMode = "ask" | "steer";
/** What to do when a project rule is judged violated on a write/edit. */
export type RuleViolationAction = "steer" | "confirm" | "block";

export interface GateRulesConfig {
  /** Judge `write`/`edit` against project Markdown rules. Off by default. */
  enabled: boolean;
  /** Files scanned for rules, relative to cwd. */
  files: string[];
  /** Cap on rules sent per request (one Noul each). */
  maxRules: number;
  /** Noul probability above which a rule counts as violated. */
  violationThreshold: number;
  /** What a live gate does about a violation. */
  onViolation: RuleViolationAction;
}

export interface GateFastPathConfig {
  /** Known-dangerous command patterns are decided locally, without Jev. */
  enabled: boolean;
  /** `false` degrades a fast-path hit to confirm instead of block. */
  block: boolean;
}

export interface GateConfig {
  enabled: boolean;
  shadow: boolean;
  timeoutMs: number;
  /** Enables the two `block` rows. Off by default in v1. */
  allowBlock: boolean;
  /** What a live gate does when classification fails. Default `allow`. */
  onFailure: GateFailurePolicy;
  /** What a live gate does when it wants to confirm but `ctx.hasUI` is false. */
  withoutUi: ConfirmPolicy;
  /** How a live `confirm` outcome is delivered. */
  confirmMode: GateConfirmMode;
  /** Deterministic pre-filter for obvious commands, independent of Jev. */
  fastPath: GateFastPathConfig;
  /** Semantic lint of writes/edits against project rules. */
  rules: GateRulesConfig;
  thresholds: GateThresholds;
  skipTools: string[];
  /** "default" or a list of read-only command prefixes. */
  skipCommands: "default" | string[];
  diskCache: boolean;
}

export interface ShieldConfig {
  enabled: boolean;
  shadow: boolean;
  timeoutMs: number;
  injectionThreshold: number;
  secretThreshold: number;
  personalDataThreshold: number;
  /** Pattern-match obvious injection phrasing without a Jev call. */
  deterministicInjection: boolean;
}

export interface PruneConfig {
  enabled: boolean;
  shadow: boolean;
  timeoutMs: number;
  minLines: number;
  relevanceThreshold: number;
}

export interface WatchdogConfig {
  enabled: boolean;
  shadow: boolean;
  timeoutMs: number;
  everyNTurns: number;
  minTurns: number;
  loopThreshold: number;
  falseDoneThreshold: number;
  /** Treat a completion claim with no test/build/lint/read-back as false-done. */
  requireEvidence: boolean;
}

export interface ModulesConfig {
  router: RouterConfig;
  gate: GateConfig;
  shield: ShieldConfig;
  prune: PruneConfig;
  watchdog: WatchdogConfig;
}

export interface BudgetConfig {
  maxRequestsPerSession: number;
  maxTokensPerSession: number;
  onBreach: "disable" | "warn";
  /** Optional TypeSafe pricing, USD per million tokens. 0 disables cost display. */
  inputPricePerMTok: number;
  outputPricePerMTok: number;
}

export interface ResidencyConfig {
  enabled: boolean;
  allowedModels: string[];
  allowedRepos: string[];
}

export type RedactionPatterns = "default" | "strict" | { custom: string[] } | string;

export interface RedactionConfig {
  patterns: RedactionPatterns;
  maxStateChars: number;
  /**
   * Token ceiling for the redacted state. Jev allows 64k for state+questions
   * and 32k for state+the longest question; 32k is the safe default. The
   * effective cap is the tighter of this and `maxStateChars`.
   */
  maxStateTokens: number;
}

export interface TelemetryConfig {
  enabled: boolean;
  dir: string;
  /** Persist full probability vectors (the initial plan requires full probabilities for threshold sweeps). */
  logProbabilities: boolean;
  logStateHash: boolean;
  /** Off by default: logs hold hashes, not prompts. */
  logStateContent: boolean;
}

export interface Config {
  apiKeyEnv: string;
  model: string;
  /** Override for a self-hosted proxy (initial_plan.md §15.4). */
  baseUrl: string;
  budget: BudgetConfig;
  residency: ResidencyConfig;
  redaction: RedactionConfig;
  modules: ModulesConfig;
  telemetry: TelemetryConfig;
}

/* -------------------------------------------------------------------------- */
/* Session state and dependencies                                             */
/* -------------------------------------------------------------------------- */

/** Mutable per-session state shared through `Deps`. Never imported between modules directly. */
export interface SessionState {
  /** Whole-layer kill switch (`/jev off`, missing key, residency). */
  layerEnabled: boolean;
  /** Effective shadow flags, including session overrides from `/jev shadow`. */
  shadow: Record<ModuleName, boolean>;
  /** Set when the client disables itself for the session. */
  clientDisabledReason: string | null;
  /** Request classes disabled after repeated failures. */
  disabledHooks: Set<HookName>;
  requests: number;
  tokens: number;
  costUsd: number;
  /** Tier chosen by the most recent router decision, for the status line. */
  activeTier?: TierName;
  /** Set while a hook is in its three-strike failure window. */
  degraded: boolean;
  sessionId?: string;
  /** Last classification per module, for `/jev explain`. */
  last: Partial<Record<ModuleName, TelemetryRecord>>;
}

export interface TelemetryRecord {
  ts?: string;
  session?: string;
  hook: ModuleName | "client";
  questionsVersion: string;
  /** sha256 of the redacted state. */
  stateHash: string;
  tool?: string;
  /** Full answers, with probabilities when `telemetry.logProbabilities`. */
  answers?: Record<string, Answer | undefined>;
  decision: string;
  shadow: boolean;
  wouldHaveBeen?: string;
  /** Gate only: the label supplied by the user's confirm answer. */
  userChoice?: "allow" | "deny" | "unknown";
  latencyMs?: number;
  cached?: boolean;
  usage?: TokenUsage;
  /** Versioned model the API reported answering, when available. */
  answeredModel?: string;
  error?: string;
  reason?: string;
  /** Redacted state, only when `telemetry.logStateContent` is set. */
  state?: unknown;
  detail?: Record<string, unknown>;
}

export type TelemetryFn = (record: TelemetryRecord) => void;

/** Dependencies handed to every module's `register(pi, deps)`. */
export interface Deps {
  config: Config;
  ask: AskFn;
  log: TelemetryFn;
  redact: RedactFn;
  state: SessionState;
  /** Writes the `jev` status line. Bound to the current UI context by index.ts. */
  status(text: string | undefined): void;
  /** Persists a durable, non-LLM transcript entry (best effort). */
  appendEntry(record: TelemetryRecord): void;
  now(): number;
}
