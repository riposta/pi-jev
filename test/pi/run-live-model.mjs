#!/usr/bin/env node
/**
 * Fully live end-to-end: a real `pi` session on a real Anthropic-compatible
 * model provider (DeepSeek) with classification against the real
 * `api.typesafe.ai`, and the router live so it actually switches the model.
 *
 *   node test/pi/run-live-model.mjs
 *
 * Env:
 *   ANTHROPIC_API_KEY  required
 *   BASE_URL           Anthropic-compatible base URL (default DeepSeek)
 *   LIVE_CHEAP_MODEL   default "deepseek-flash"
 *   LIVE_STRONG_MODEL  default "deepseek-v4-pro"
 *   TYPESAFE_API_KEY   required for classification
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const piBin = process.env.PI_BIN ?? "pi";
const apiKey = process.env.ANTHROPIC_API_KEY;
const baseUrl = process.env.BASE_URL ?? "https://api.deepseek.com/anthropic";
const typesafeUrl = process.env.PI_JEV_BASE_URL ?? "https://api.typesafe.ai";
const cheapModel = process.env.LIVE_CHEAP_MODEL ?? "deepseek-flash";
const strongModel = process.env.LIVE_STRONG_MODEL ?? "deepseek-v4-pro";

if (!apiKey || !process.env.TYPESAFE_API_KEY) {
  console.log("skipped: ANTHROPIC_API_KEY and TYPESAFE_API_KEY are required");
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "pi-jev-live-model-"));
const agent = join(work, "agent");
const cwd = join(work, "work");
mkdirSync(agent, { recursive: true });
mkdirSync(cwd, { recursive: true });

const model = (id) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
writeFileSync(
  join(agent, "models.json"),
  JSON.stringify({
    providers: {
      deepseek: {
        baseUrl,
        api: "anthropic-messages",
        apiKey: "$ANTHROPIC_API_KEY",
        models: [model(cheapModel), model(strongModel)],
      },
    },
  }),
);

mkdirSync(join(work, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(work, ".pi", "agent", "jev.json"),
  JSON.stringify({
    modules: {
      router: {
        enabled: true,
        shadow: false,
        timeoutMs: 20000,
        tiers: {
          cheap: { provider: "deepseek", model: cheapModel, thinking: "off" },
          standard: { provider: "deepseek", model: strongModel, thinking: "off" },
          strong: { provider: "deepseek", model: strongModel, thinking: "off" },
        },
      },
    },
  }),
);

const failures = [];
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "  ✓" : "  ✗"} ${name}${condition || !detail ? "" : ` — ${detail}`}`);
  if (!condition) failures.push(name);
};

const logDir = join(cwd, ".pi", "jev-log");

/** Warm the TLS connection / TypeSafe cold path before measuring. */
async function warmup() {
  try {
    await fetch(`${typesafeUrl.replace(/\/$/, "")}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
      body: JSON.stringify({
        model: "jev-latest",
        state: { ping: "hello" },
        questions: { alive: { type: "noul", instructions: "Is `ping` non-empty?" } },
      }),
    });
  } catch {
    // Warmup is best effort.
  }
}

const run = (args, timeoutMs = 180_000) =>
  new Promise((resolve) => {
    const child = spawn(piBin, args, {
      cwd,
      env: {
        ...process.env,
        HOME: work,
        PI_OFFLINE: "1",
        PI_CODING_AGENT_DIR: agent,
        PI_JEV_BASE_URL: typesafeUrl,
        PI_JEV_ROUTER_SHADOW: "false",
        PI_JEV_ROUTER_TIMEOUT_MS: "20000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

const PROMPT =
  "Implement a new feature: add cursor pagination to the /users endpoint across the controller, the service and the repository files. Keep it to one short reply; do not run commands.";

async function attempt() {
  rmSync(logDir, { recursive: true, force: true });
  const result = await run([
    "--mode", "json",
    "--no-extensions", "--no-session", "--no-context-files", "--no-approve",
    "-e", join(root, "src", "index.ts"),
    "--model", `deepseek/${cheapModel}`,
    PROMPT,
  ]);
  const events = result.stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const records = existsSync(logDir)
    ? readdirSync(logDir)
        .filter((name) => name.endsWith(".jsonl"))
        .flatMap((name) =>
          readFileSync(join(logDir, name), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        )
    : [];
  return {
    result,
    records,
    router: records.find((record) => record.hook === "router"),
    modelSelects: events.filter((event) => event.type === "model_select").map((event) => event.model?.id),
    assistantModels: events
      .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
      .map((event) => event.message.model),
  };
}

let exitCode = 1;
try {
  await warmup();
  let data = await attempt();
  if (data.router?.decision === "fail_open") {
    console.log("router hit fail_open (transient); retrying once...");
    data = await attempt();
  }

  console.log(`pi exit: ${data.result.code}`);
  console.log(`initial model: deepseek/${cheapModel}`);
  console.log(`router decision: ${data.router?.decision ?? "(none)"} -> model_select: ${JSON.stringify(data.modelSelects)}`);
  console.log(`assistant models: ${JSON.stringify(data.assistantModels)}`);

  check("pi exited 0", data.result.code === 0, `${data.result.code} ${data.result.stderr.slice(-300)}`);
  check("real Jev classified the prompt", ["cheap", "standard", "strong"].includes(data.router?.decision), JSON.stringify(data.router?.decision));
  check("real Jev reported token usage", (data.router?.usage?.input_tokens ?? 0) > 0, JSON.stringify(data.router?.usage));
  check("router chose a tier above cheap", data.router?.decision === "standard" || data.router?.decision === "strong", JSON.stringify(data.router?.decision));
  check("the run used the strong model", data.assistantModels.includes(strongModel), JSON.stringify(data.assistantModels));
  check("assistant produced a reply", data.assistantModels.length > 0);
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  if (exitCode === 0 && process.env.KEEP_TMP !== "1") rmSync(work, { recursive: true, force: true });
  else console.log(`workspace kept: ${work}`);
}

console.log(failures.length === 0 ? "\nLIVE MODEL PASS" : `\nLIVE MODEL FAIL: ${failures.length}`);
process.exit(exitCode);
