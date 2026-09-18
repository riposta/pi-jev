/**
 * redact.ts — deterministic, pattern-based scrubbing applied before anything
 * leaves the machine.
 *
 * This is deliberately over-eager (initial_plan.md §15.2). Losing a little classification
 * accuracy is the correct trade against leaking a credential. The known
 * limitation is that shield exists to catch secrets patterns miss, but content
 * must reach Jev to be classified; patterns reduce exposure, they do not
 * eliminate it.
 */

import type { RedactFn, RedactionPatterns } from "./types.ts";

export class RedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedactionError";
  }
}

interface Rule {
  name: string;
  pattern: RegExp;
  replace: string | ((...args: string[]) => string);
}

const PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KNOWN_TOKEN =
  /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const URL_CREDENTIALS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/g;
const ENV_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET|CREDENTIAL)[A-Za-z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** Absolute paths from common roots are reduced to their basename. */
const POSIX_PATH = /(?:\/(?:Users|home|private|var|tmp|opt|srv|etc|Volumes)\/[^\s"'`),;:]*?)(?=[\s"'`),;:]|$)/g;
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\s\\]+\\?)+/g;

function basename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

const DEFAULT_RULES: Rule[] = [
  { name: "private-key", pattern: PRIVATE_KEY, replace: "[redacted private key]" },
  { name: "authorization", pattern: BEARER, replace: "$1 [redacted]" },
  { name: "known-token", pattern: KNOWN_TOKEN, replace: "[redacted token]" },
  { name: "jwt", pattern: JWT, replace: "[redacted jwt]" },
  { name: "url-credentials", pattern: URL_CREDENTIALS, replace: "$1[redacted]@" },
  { name: "env-assignment", pattern: ENV_ASSIGNMENT, replace: "$1=[redacted]" },
  { name: "email", pattern: EMAIL, replace: "[redacted email]" },
  { name: "posix-path", pattern: POSIX_PATH, replace: (match) => basename(match) },
  { name: "windows-path", pattern: WINDOWS_PATH, replace: (match) => basename(match) },
];

const STRICT_RULES: Rule[] = [
  { name: "credit-card", pattern: /\b(?:\d[ -]?){13,19}\b/g, replace: "[redacted card]" },
  { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replace: "[redacted id]" },
  { name: "ipv4", pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, replace: "[redacted ip]" },
  { name: "phone", pattern: /\b\+?\d[\d ().-]{7,}\d\b/g, replace: "[redacted number]" },
];

export interface RedactorOptions {
  patterns?: RedactionPatterns;
  /** Extra regex sources, already resolved from the config file by config.ts. */
  customPatterns?: string[];
}

function compileCustom(sources: string[]): Rule[] {
  return sources.map((source, index) => {
    try {
      return { name: `custom-${index}`, pattern: new RegExp(source, "g"), replace: "[redacted]" };
    } catch (error) {
      throw new RedactionError(`Invalid custom redaction pattern "${source}": ${(error as Error).message}`);
    }
  });
}

function applyRules(text: string, rules: Rule[]): string {
  let out = text;
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (typeof rule.replace === "function") {
      out = out.replace(pattern, rule.replace as (...args: string[]) => string);
    } else {
      out = out.replace(pattern, rule.replace);
    }
  }
  return out;
}

/** Builds the redactor. `deep` walks objects and arrays, redacting string leaves. */
export function createRedactor(options: RedactorOptions = {}): RedactFn {
  const strict = options.patterns === "strict";
  const custom = options.customPatterns ?? [];
  const rules = [...DEFAULT_RULES, ...(strict ? STRICT_RULES : []), ...compileCustom(custom)];

  const redact = ((text: string): string => {
    if (typeof text !== "string" || text.length === 0) return text;
    return applyRules(text, rules);
  }) as RedactFn;

  function walk(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      return value.map((entry) => walk(entry, seen));
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) out[key] = walk(entry, seen);
      return out;
    }
    return value;
  }

  redact.deep = (value: unknown): unknown => walk(value, new WeakSet());

  return redact;
}

/** Exposed for the redaction tests: the rule names, in application order. */
export function ruleNames(): string[] {
  return [...DEFAULT_RULES, ...STRICT_RULES].map((rule) => rule.name);
}
