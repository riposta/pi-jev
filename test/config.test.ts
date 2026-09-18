import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { ConfigError, effectiveSkipCommands, loadConfig, timeouts, DEFAULT_SKIP_COMMANDS } from "../src/config.ts";

const HOME = "/home/tester";
const CWD = "/repo";

function readFileMap(files: Record<string, unknown>) {
  return (path: string): string | undefined => {
    const value = files[path];
    return value === undefined ? undefined : typeof value === "string" ? value : JSON.stringify(value);
  };
}

describe("config resolution", () => {
  it("returns built-in defaults when no file exists", () => {
    const config = loadConfig({ cwd: CWD, homeDir: HOME, env: {}, readFile: () => undefined });
    expect(config.model).toBe("jev-latest");
    expect(config.modules.router.shadow).toBe(true);
    expect(config.modules.gate.enabled).toBe(true);
    expect(config.modules.prune.enabled).toBe(false);
    expect(config.modules.watchdog.minTurns).toBe(6);
  });

  it("merges a user config over defaults and a project config over that", () => {
    const config = loadConfig({
      cwd: CWD,
      homeDir: HOME,
      trusted: true,
      env: {},
      readFile: readFileMap({
        [join(HOME, ".pi", "agent", "jev.json")]: { model: "user-model", modules: { router: { confidenceFloor: 0.7 } } },
        [join(CWD, ".pi", "jev.json")]: { model: "project-model", modules: { gate: { shadow: false } } },
      }),
    });
    expect(config.model).toBe("project-model");
    expect(config.modules.router.confidenceFloor).toBe(0.7);
    expect(config.modules.gate.shadow).toBe(false);
    // untouched nested defaults survive
    expect(config.modules.router.tiers.strong.model).toBe("claude-opus-5");
  });

  it("ignores project config when the project is not trusted", () => {
    const config = loadConfig({
      cwd: CWD,
      homeDir: HOME,
      trusted: false,
      env: {},
      readFile: readFileMap({ [join(CWD, ".pi", "jev.json")]: { model: "project-model" } }),
    });
    expect(config.model).toBe("jev-latest");
  });

  it("lets environment variables win over files", () => {
    const config = loadConfig({
      cwd: CWD,
      homeDir: HOME,
      trusted: true,
      env: {
        PI_JEV_MODEL: "env-model",
        PI_JEV_BASE_URL: "http://localhost:9999",
        PI_JEV_GATE_SHADOW: "false",
        PI_JEV_ROUTER_ENABLED: "0",
      },
      readFile: readFileMap({ [join(CWD, ".pi", "jev.json")]: { model: "project-model" } }),
    });
    expect(config.model).toBe("env-model");
    expect(config.baseUrl).toBe("http://localhost:9999");
    expect(config.modules.gate.shadow).toBe(false);
    expect(config.modules.router.enabled).toBe(false);
  });

  it("PI_JEV_OFF disables every module", () => {
    const config = loadConfig({ cwd: CWD, homeDir: HOME, env: { PI_JEV_OFF: "1" }, readFile: () => undefined });
    expect(config.modules.router.enabled).toBe(false);
    expect(config.modules.gate.enabled).toBe(false);
    expect(config.modules.shield.enabled).toBe(false);
  });
});

describe("config validation", () => {
  it("raises a clear ConfigError on invalid JSON", () => {
    expect(() =>
      loadConfig({
        cwd: CWD,
        homeDir: HOME,
        trusted: true,
        env: {},
        readFile: readFileMap({ [join(CWD, ".pi", "jev.json")]: "{ not json" }),
      }),
    ).toThrow(ConfigError);
  });

  it("rejects out-of-range thresholds", () => {
    expect(() =>
      loadConfig({
        cwd: CWD,
        homeDir: HOME,
        trusted: true,
        env: {},
        readFile: readFileMap({
          [join(CWD, ".pi", "jev.json")]: { modules: { gate: { thresholds: { confirmBlastRadius: 9 } } } },
        }),
      }),
    ).toThrow(/confirmBlastRadius/);
  });

  it("rejects an invalid base URL", () => {
    expect(() =>
      loadConfig({
        cwd: CWD,
        homeDir: HOME,
        env: { PI_JEV_BASE_URL: "not a url" },
        readFile: () => undefined,
      }),
    ).toThrow(/baseUrl/);
  });

  it("rejects unsorted thinking bands", () => {
    expect(() =>
      loadConfig({
        cwd: CWD,
        homeDir: HOME,
        trusted: true,
        env: {},
        readFile: readFileMap({
          [join(CWD, ".pi", "jev.json")]: {
            modules: { router: { thinkingBands: [{ max: 2, level: "high" }, { max: 1, level: "low" }] } },
          },
        }),
      }),
    ).toThrow(/thinkingBands/);
  });
});

describe("derived config", () => {
  it("shares the larger timeout between shield and prune", () => {
    const config = loadConfig({ cwd: CWD, homeDir: HOME, env: {}, readFile: () => undefined });
    expect(timeouts(config).shield_prune).toBe(3000);
  });

  it("lets the environment override a per-module timeout", () => {
    const config = loadConfig({
      cwd: CWD,
      homeDir: HOME,
      env: { PI_JEV_GATE_TIMEOUT_MS: "1234" },
      readFile: () => undefined,
    });
    expect(config.modules.gate.timeoutMs).toBe(1234);
    expect(timeouts(config).gate).toBe(1234);
  });

  it("resolves the default allowlist and a custom one", () => {
    const config = loadConfig({ cwd: CWD, homeDir: HOME, env: {}, readFile: () => undefined });
    expect(effectiveSkipCommands(config.modules.gate)).toBe(DEFAULT_SKIP_COMMANDS);
    config.modules.gate.skipCommands = ["git status"];
    expect(effectiveSkipCommands(config.modules.gate)).toEqual(["git status"]);
  });
});
