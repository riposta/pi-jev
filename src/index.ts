/**
 * pi-jev — a Jev classification layer for the Pi coding agent.
 *
 * This file contains no decision logic. It loads config, builds the client,
 * redactor and telemetry singletons, and wires modules to hooks. Modules never
 * import each other; shared state goes through `deps` (initial_plan.md §5.2).
 *
 * One deliberate deviation from the per-module `register` sketch: shield and
 * prune share a single tool_result request (initial_plan.md §5.4), so index.ts owns that one
 * pipeline and dispatches to both modules' pure evaluators. That keeps the
 * "one request per hook" rule and the "modules never import each other" rule
 * true at the same time.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { defaultConfig, loadConfig, resolveCustomPatterns, ConfigError } from "./config.ts";
import { createRedactor } from "./redact.ts";
import { createClient } from "./client.ts";
import {
  createTelemetry,
  formatExplain,
  formatStatus,
  readLog,
  summarise,
} from "./telemetry.ts";
import { QUESTIONS_VERSION, SHIELD_PRUNE_QUESTIONS } from "./questions.ts";
import type { AskFn, Config, Deps, ModuleName, RedactFn, SessionState, TelemetryRecord } from "./types.ts";
import * as router from "./modules/router.ts";
import * as gate from "./modules/gate.ts";
import * as shield from "./modules/shield.ts";
import * as prune from "./modules/prune.ts";
import * as watchdog from "./modules/watchdog.ts";

const MODULES: ModuleName[] = ["router", "gate", "shield", "prune", "watchdog"];

const identityRedact = ((text: string) => text) as RedactFn;
identityRedact.deep = (value) => value;

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export function isRepoAllowed(cwd: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  const normalizedCwd = cwd.replace(/[\\/]+$/, "");
  const name = basename(normalizedCwd);
  return allowed.some((raw) => {
    const entry = raw.replace(/[\\/]+$/, "");
    if (entry.length === 0) return false;
    // A bare name matches the repository basename; a path must match exactly
    // or as an ancestor on a path boundary (so /a/b never matches /a/bc).
    if (!entry.includes("/") && !entry.includes("\\")) return entry === name;
    return (
      normalizedCwd === entry ||
      normalizedCwd.startsWith(`${entry}/`) ||
      normalizedCwd.startsWith(`${entry}\\`)
    );
  });
}

export default function piJev(pi: ExtensionAPI): void {
  const state: SessionState = {
    layerEnabled: false,
    shadow: { router: true, gate: true, shield: true, prune: true, watchdog: true },
    clientDisabledReason: null,
    disabledHooks: new Set(),
    requests: 0,
    tokens: 0,
    costUsd: 0,
    degraded: false,
    last: {},
  };
  let config: Config = defaultConfig();
  let telemetry: ReturnType<typeof createTelemetry> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let redactor: RedactFn = identityRedact;
  let currentCtx: ExtensionContext | undefined;
  let configured = false;

  const MAX_TRACE = 8;
  const traceLines: string[] = [];

  function refreshWidget(): void {
    if (!config.telemetry.traceWidget) return;
    const lines = traceLines.slice(-MAX_TRACE);
    currentCtx?.ui.setWidget("jev-trace", lines.length > 0 ? lines : undefined, {
      placement: "belowEditor",
    });
  }

  const ask: AskFn = (hook, rawState, questions, opts) =>
    client ? client.ask(hook, rawState, questions, opts) : Promise.resolve(null);

  const deps: Deps = {
    get config() {
      return config;
    },
    get redact() {
      return redactor;
    },
    ask,
    log: (record) => telemetry?.log(record),
    appendEntry: (record) => {
      // Mirror telemetry's stamping and privacy rules: the durable transcript
      // must not carry more than the log does.
      const stamped: TelemetryRecord = {
        ...record,
        ts: new Date().toISOString(),
        questionsVersion: record.questionsVersion || QUESTIONS_VERSION,
      };
      if (!config.telemetry.logStateContent) delete stamped.state;
      pi.appendEntry("jev-decision", stamped);
      const line = `${stamped.hook}${stamped.tool ? ` ${stamped.tool}` : ""}: ${stamped.decision}${
        stamped.shadow ? " [shadow]" : ""
      }${
        stamped.wouldHaveBeen && stamped.wouldHaveBeen !== stamped.decision
          ? ` → ${stamped.wouldHaveBeen}`
          : ""
      }`;
      traceLines.push(line);
      if (traceLines.length > MAX_TRACE) traceLines.shift();
      refreshWidget();
    },
    state,
    status: (text) => currentCtx?.ui.setStatus("jev", text),
    now: () => Date.now(),
  };

  /* ---------------------------------------------------------------------- */
  /* Durable, LLM-free transcript entries (initial_plan.md §13.5)                        */
  /* ---------------------------------------------------------------------- */

  pi.registerEntryRenderer<TelemetryRecord>("jev-decision", (entry, options, theme) => {
    const record = entry.data;
    const label = `${record?.hook ?? "jev"}: ${record?.decision ?? "?"}${
      record?.shadow ? " [shadow]" : ""
    }${record?.wouldHaveBeen && record.wouldHaveBeen !== record.decision ? ` → ${record.wouldHaveBeen}` : ""}`;
    const body = options.expanded ? formatExplain(record).split("\n") : [];
    const lines = [record?.tool ? `${label} (${record.tool})` : label, ...body];
    const text = lines.map((line, index) => (index === 0 ? theme.fg("dim", line) : line));
    return {
      render: (width: number) => text.map((line) => line.slice(0, Math.max(0, width))),
      invalidate: () => {},
    };
  });

  /* ---------------------------------------------------------------------- */
  /* Session lifecycle                                                      */
  /* ---------------------------------------------------------------------- */

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    try {
      config = loadConfig({
        cwd: ctx.cwd,
        trusted: ctx.isProjectTrusted(),
        configDirName: CONFIG_DIR_NAME,
      });
    } catch (error) {
      state.layerEnabled = false;
      const message = error instanceof ConfigError ? error.message : (error as Error).message;
      ctx.ui.notify(`pi-jev disabled: ${message}`, "error");
      configured = true;
      return;
    }

    // Reset per-session counters and shadow overrides.
    state.requests = 0;
    state.tokens = 0;
    state.costUsd = 0;
    state.degraded = false;
    state.clientDisabledReason = null;
    state.disabledHooks.clear();
    state.activeTier = undefined;
    for (const module of MODULES) state.shadow[module] = config.modules[module].shadow;
    state.sessionId = sessionId(ctx);
    traceLines.length = 0;

    try {
      const customPatterns = resolveCustomPatterns(config, ctx.cwd);
      redactor = createRedactor({ patterns: config.redaction.patterns, customPatterns });
    } catch (error) {
      state.layerEnabled = false;
      ctx.ui.notify(`pi-jev disabled: ${(error as Error).message}`, "error");
      configured = true;
      return;
    }

    telemetry = createTelemetry({ config, cwd: ctx.cwd });
    client = createClient({
      config,
      state,
      log: (record) => telemetry?.log(record),
      redact: redactor,
      status: deps.status,
      cwd: ctx.cwd,
      configDirName: CONFIG_DIR_NAME,
    });

    if (config.residency.enabled && !isRepoAllowed(ctx.cwd, config.residency.allowedRepos)) {
      state.layerEnabled = false;
      ctx.ui.notify("pi-jev: disabled outside the repositories allowed by residency policy", "info");
    } else {
      state.layerEnabled = true;
    }

    if (!client.hasApiKey) {
      ctx.ui.notify(`pi-jev: ${config.apiKeyEnv} is not set; layer disabled (fail-open)`, "warning");
    }

    configured = true;
    deps.status(formatStatus(state, config));
    ctx.ui.notify(`pi-jev ready (${QUESTIONS_VERSION})`, "info");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("jev", undefined);
    ctx.ui.setWidget("jev-trace", undefined);
  });

  /* ---------------------------------------------------------------------- */
  /* Module hooks                                                           */
  /* ---------------------------------------------------------------------- */

  router.register(pi, deps);
  gate.register(pi, deps);
  watchdog.register(pi, deps);
  registerToolResultPipeline(pi, deps);

  /* ---------------------------------------------------------------------- */
  /* Commands (initial_plan.md §14)                                                      */
  /* ---------------------------------------------------------------------- */

  pi.registerCommand("jev", {
    description: "pi-jev status, explanation, shadow toggles and stats",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      if (!configured) {
        ctx.ui.notify("pi-jev is still starting.", "info");
        return;
      }
      if (sub === "explain") {
        const hookName = rest[0];
        const record =
          hookName && MODULES.includes(hookName as ModuleName)
            ? telemetry?.lastFor(hookName as TelemetryRecord["hook"])
            : telemetry?.recent().at(-1);
        ctx.ui.notify(formatExplain(record), "info");
        return;
      }
      if (sub === "off") {
        state.layerEnabled = false;
        deps.status(formatStatus(state, config));
        ctx.ui.notify("pi-jev disabled for this session.", "info");
        return;
      }
      if (sub === "on") {
        state.layerEnabled = true;
        deps.status(formatStatus(state, config));
        ctx.ui.notify("pi-jev enabled for this session.", "info");
        return;
      }
      if (sub === "shadow") {
        const module = rest[0] as ModuleName | undefined;
        const value = rest[1];
        if (!module || !MODULES.includes(module) || !["on", "off"].includes(value ?? "")) {
          ctx.ui.notify("usage: /jev shadow <router|gate|shield|prune|watchdog> on|off", "info");
          return;
        }
        state.shadow[module] = value === "on";
        ctx.ui.notify(`pi-jev: ${module} shadow ${value} (this session only).`, "info");
        return;
      }
      if (sub === "trace") {
        const count = Number(rest[0] ?? "5");
        const recent = telemetry?.recent() ?? [];
        const lines = recent.slice(-(Number.isFinite(count) && count > 0 ? count : 5)).map((record) =>
          `${record.hook}${record.tool ? ` (${record.tool})` : ""}: ${record.decision}${
            record.shadow ? " [shadow]" : ""
          }${
            record.wouldHaveBeen && record.wouldHaveBeen !== record.decision
              ? ` → ${record.wouldHaveBeen}`
              : ""
          }${record.reason ? ` — ${record.reason}` : ""}`,
        );
        ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "jev: no decisions yet.", "info");
        return;
      }
      if (sub === "recommend") {
        const dir = telemetry?.dir() ?? "";
        const records = readLog({ dir });
        const labels = records.filter(
          (record) => record.hook === "gate" && (record.userChoice === "allow" || record.userChoice === "deny"),
        );
        const denied = labels.filter((record) => record.userChoice === "deny").length;
        const rate = labels.length > 0 ? denied / labels.length : Number.NaN;
        const advice = !Number.isFinite(rate)
          ? "no gate labels yet — promote confirm and work normally to collect them"
          : rate > 0.3
            ? "deny rate is high: relax confirm thresholds with tools/calibrate.ts"
            : "deny rate looks acceptable: keep the current thresholds";
        ctx.ui.notify(
          `pi-jev recommend (${records.length} records, ${labels.length} gate labels)\n` +
            `confirm deny rate: ${Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : "n/a"}\n→ ${advice}`,
          "info",
        );
        return;
      }
      if (sub === "stats") {
        const days = Number(rest[0] ?? "1");
        const since = Number.isFinite(days)
          ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
          : undefined;
        const dir = telemetry?.dir() ?? "";
        const records = readLog({ dir, since });
        const stats = summarise(records);
        ctx.ui.notify(
          `pi-jev stats (${since ?? "all"} → now): ${stats.total} decisions\n` +
            `by decision: ${JSON.stringify(stats.byDecision)}\n` +
            `gate labels: ${JSON.stringify(stats.confirmLabels)} · cache hits: ${stats.cacheHits}`,
          "info",
        );
        return;
      }
      ctx.ui.notify(summary(), "info");
    },
  });

  function summary(): string {
    const lines = [formatStatus(state, config), `model ${config.model} · questions ${QUESTIONS_VERSION}`];
    for (const module of MODULES) {
      const enabled = config.modules[module].enabled;
      lines.push(`  ${module}: ${enabled ? (state.shadow[module] ? "shadow" : "live") : "off"}`);
    }
    lines.push(`usage: ${state.requests} req · ${state.tokens} tokens · $${state.costUsd.toFixed(4)}`);
    return lines.join("\n");
  }
}

/* -------------------------------------------------------------------------- */
/* Shared tool_result pipeline: shield + prune, one request (initial_plan.md §5.4)         */
/* -------------------------------------------------------------------------- */

function registerToolResultPipeline(pi: ExtensionAPI, deps: Deps): void {
  pi.on("tool_result", async (event, ctx) => {
    const { state, config } = deps;
    const shieldEnabled = config.modules.shield.enabled;
    const pruneEnabled = config.modules.prune.enabled;
    if (!state.layerEnabled || (!shieldEnabled && !pruneEnabled)) return;

    const raw = shield.resultText(event.content);
    const sampled = shield.sampleToolOutput(raw);
    const toolState = {
      tool: event.toolName,
      tool_output: sampled.text,
      is_error: event.isError,
      cwd_basename: basename(ctx.cwd),
    };

    const result = await deps.ask("shield_prune", toolState, SHIELD_PRUNE_QUESTIONS, {
      signal: ctx.signal,
    });
    const injectionFloor = config.modules.shield.deterministicInjection ? shield.deterministicInjection(raw) : 0;
    if (!result) {
      // Offline floor: classic injections are withheld even when Jev is
      // unavailable, so the shield is not a no-op without a key.
      const caughtOffline = !state.shadow.shield && shieldEnabled && injectionFloor > config.modules.shield.injectionThreshold;
      deps.log({
        hook: "shield",
        questionsVersion: "",
        stateHash: "",
        tool: event.toolName,
        decision: caughtOffline ? "replace" : "fail_open",
        shadow: state.shadow.shield,
        wouldHaveBeen: caughtOffline ? "replace" : "fail_open",
        reason: caughtOffline ? `prompt injection (deterministic ${injectionFloor.toFixed(2)})` : "classification unavailable",
        detail: { deterministicInjection: injectionFloor },
      });
      if (caughtOffline) {
        return { content: [{ type: "text" as const, text: shield.withheldNotice(event.toolName, {
          replace: true,
          reasons: [`prompt injection (deterministic ${injectionFloor.toFixed(2)})`],
          injection: injectionFloor,
          secret: 0,
          personalData: 0,
        }) }] };
      }
      return;
    }

    const shieldDecision = shield.evaluateShield(result.answers, config, injectionFloor);
    const pruneDecision = prune.evaluatePrune(result.answers, config, sampled.totalLines);
    const shadow = state.shadow.shield;

    const shieldRecord: TelemetryRecord = {
      hook: "shield",
      questionsVersion: "",
      stateHash: result.meta.stateHash,
      state: result.meta.redactedState,
      tool: event.toolName,
      answers: result.answers,
      decision: shadow ? "keep" : shieldDecision.replace ? "replace" : shieldDecision.reasons.length ? "mask" : "keep",
      shadow,
      wouldHaveBeen: shieldDecision.replace ? "replace" : shieldDecision.reasons.length ? "mask" : "keep",
      latencyMs: result.meta.latencyMs,
      cached: result.meta.cached,
      usage: result.meta.usage,
      answeredModel: result.meta.answeredModel,
      reason: shieldDecision.reasons.join(", ") || undefined,
      detail: {
        injection: shieldDecision.injection,
        secret: shieldDecision.secret,
        personalData: shieldDecision.personalData,
        deterministicInjection: injectionFloor,
        droppedLines: sampled.droppedLines,
      },
    };
    deps.log(shieldRecord);
    deps.appendEntry(shieldRecord);
    state.last.shield = shieldRecord;

    const pruneRecord: TelemetryRecord = {
      hook: "prune",
      questionsVersion: "",
      stateHash: result.meta.stateHash,
      state: result.meta.redactedState,
      tool: event.toolName,
      answers: result.answers,
      decision: state.shadow.prune || !pruneDecision.prune ? "keep" : "prune",
      shadow: state.shadow.prune,
      wouldHaveBeen: pruneDecision.prune ? "prune" : "keep",
      latencyMs: result.meta.latencyMs,
      cached: result.meta.cached,
      usage: result.meta.usage,
      answeredModel: result.meta.answeredModel,
      detail: { relevance: pruneDecision.relevance, totalLines: sampled.totalLines },
    };
    deps.log(pruneRecord);
    deps.appendEntry(pruneRecord);
    state.last.prune = pruneRecord;
    deps.status(formatStatus(state, config));

    // Apply shield first. A withheld result is never masked or pruned, and a
    // masked result is never pruned, so a detected secret never lands in a temp
    // file unredacted.
    if (!state.shadow.shield && shieldEnabled && shieldDecision.replace) {
      return { content: [{ type: "text" as const, text: shield.withheldNotice(event.toolName, shieldDecision) }] };
    }
    if (!state.shadow.shield && shieldEnabled && shield.shieldHasMasking(shieldDecision)) {
      // maskContent keeps the original block shape (text redacted, non-text
      // passed through), so this is a same-shape, redacted copy of the input.
      return { content: shield.maskContent(event.content, deps.redact) as typeof event.content };
    }
    if (!state.shadow.prune && pruneEnabled && pruneDecision.prune) {
      const redactedRaw = deps.redact(raw);
      const { notice } = prune.pruneOutput(redactedRaw, event.toolCallId);
      return { content: [{ type: "text" as const, text: notice }] };
    }

    // Speculative failure-type suggestion; cheap and occasionally saves a detour.
    // It belongs to prune, so prune's own shadow flag (not shield's) gates it:
    // shield ships in shadow by default and used to suppress this silently.
    const suggestion =
      pruneEnabled && !state.shadow.prune ? prune.failureSuggestion(result.answers) : null;
    if (suggestion) {
      pi.sendMessage(
        { customType: "jev-failure", content: suggestion, display: true },
        { deliverAs: "steer" },
      );
    }
    return;
  });
}

function sessionId(ctx: ExtensionContext): string | undefined {
  const manager = ctx.sessionManager as unknown as { getSessionId?: () => string | undefined };
  return manager.getSessionId?.();
}
