/**
 * Live smoke test against api.typesafe.ai.
 *
 * Skipped unless TYPESAFE_API_KEY is set. This is the only test that touches
 * the real network; everything else runs against the local mock and is
 * deterministic in CI.
 */

import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.ts";
import { createRedactor } from "../src/redact.ts";
import { makeConfig, makeState } from "./helpers.ts";

const hasKey = Boolean(process.env.TYPESAFE_API_KEY);

describe.skipIf(!hasKey)("live TypeSafe smoke", () => {
  it("round-trips a Noul question", async () => {
    const config = makeConfig({
      baseUrl: process.env.PI_JEV_BASE_URL ?? "https://api.typesafe.ai",
      model: process.env.PI_JEV_MODEL ?? "jev-latest",
      modules: { router: { timeoutMs: 20_000 } },
    });
    const client = createClient({
      config,
      state: makeState(),
      redact: createRedactor(),
      log: () => {},
      status: () => {},
      cwd: process.cwd(),
      env: process.env,
    });
    const questions = {
      is_non_empty: { type: "noul", instructions: "Is `prompt` non-empty?" },
    } as const;
    const result = await client.ask("router", { prompt: "Say hello." }, questions, { allowCache: false });
    expect(result).not.toBeNull();
    expect(result?.answers.is_non_empty.type).toBe("noul");
    expect(result?.answers.is_non_empty.noul).toBeGreaterThan(0.5);
    expect(result?.meta.usage.input_tokens).toBeGreaterThan(0);
  }, 30_000);
});
