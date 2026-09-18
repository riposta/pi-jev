#!/usr/bin/env node
/**
 * Live end-to-end: a real `pi` session (scripted model) with pi-jev talking to
 * the real `api.typesafe.ai`. Only the LLM is mocked; the classification path
 * is not.
 *
 *   TYPESAFE_API_KEY=... node test/pi/run-live.mjs
 *
 * Skips with exit 0 when TYPESAFE_API_KEY is missing. Set PI_JEV_BASE_URL to
 * point at a self-hosted proxy instead.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.TYPESAFE_API_KEY) {
  console.log("skipped: TYPESAFE_API_KEY is not set");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const piBin = process.env.PI_BIN ?? "pi";
const modelPort = 8896;
const baseUrl = process.env.PI_JEV_BASE_URL ?? "https://api.typesafe.ai";

const work = mkdtempSync(join(tmpdir(), "pi-jev-live-"));
const agent = join(work, "agent");
const cwd = join(work, "work");
mkdirSync(agent, { recursive: true });
mkdirSync(cwd, { recursive: true });

writeFileSync(
  join(agent, "models.json"),
  JSON.stringify({
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        api: "openai-completions",
        apiKey: "mock",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
        models: [
          {
            id: "mock-1",
            name: "Mock 1",
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
);
const scriptPath = join(work, "script.json");
writeFileSync(scriptPath, JSON.stringify([{ text: "ok" }]));

const model = spawn("node", [join(here, "mock-model-server.mjs")], {
  env: { ...process.env, MOCK_SCRIPT: scriptPath, MOCK_MODEL_PORT: String(modelPort) },
  stdio: ["ignore", "pipe", "pipe"],
});
model.stdout.on("data", () => {});
model.stderr.on("data", () => {});

const failures = [];
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "  ✓" : "  ✗"} ${name}${condition || !detail ? "" : ` — ${detail}`}`);
  if (!condition) failures.push(name);
};

const run = (args, timeoutMs = 60_000) =>
  new Promise((resolve) => {
    const child = spawn(piBin, args, {
      cwd,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_CODING_AGENT_DIR: agent,
        PI_JEV_BASE_URL: baseUrl,
        // Real Jev is slower than the mock; give it room so the run is not a
        // timeout measurement.
        PI_JEV_ROUTER_TIMEOUT_MS: "8000",
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

let exitCode = 1;
try {
  const result = await run([
    "--mode", "json",
    "--no-extensions", "--no-session", "--no-context-files", "--no-approve",
    "-e", join(root, "src", "index.ts"),
    "--model", "mock/mock-1",
    "Rename the `foo` variable to `bar` in src/util.ts.",
  ]);
  console.log(`pi exit: ${result.code}; baseUrl: ${baseUrl}`);
  const logDir = join(cwd, ".pi", "jev-log");
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
  const router = records.find((record) => record.hook === "router");
  console.log(`telemetry records: ${records.length}`);
  for (const record of records) console.log(`  - ${record.hook}: ${record.decision}`);

  check("pi exited 0", result.code === 0, `${result.code} ${result.stderr.slice(-200)}`);
  check("router decision came from real Jev", ["cheap", "standard", "strong"].includes(router?.decision), JSON.stringify(router?.decision));
  check("real Jev reported token usage", (router?.usage?.input_tokens ?? 0) > 0, JSON.stringify(router?.usage));
  check("real latency recorded", (router?.latencyMs ?? 0) > 0, String(router?.latencyMs));
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  model.kill();
  if (exitCode === 0 && process.env.KEEP_TMP !== "1") rmSync(work, { recursive: true, force: true });
  else console.log(`workspace kept: ${work}`);
}

console.log(failures.length === 0 ? "\nLIVE PASS" : `\nLIVE FAIL: ${failures.length}`);
process.exit(exitCode);
