import { describe, expect, it } from "vitest";
import { createRedactor, RedactionError } from "../src/redact.ts";

describe("redact.ts", () => {
  const redact = createRedactor();

  it("scrubs known token shapes", () => {
    expect(redact("token sk-ant-abcdefghijklmnopqrstuvwx end")).not.toContain("sk-ant-abcdefghijklmnopqrstuvwx");
    expect(redact("ghp_012345678901234567890123456789")).toContain("[redacted token]");
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toContain("[redacted token]");
  });

  it("scrubs bearer tokens and authorization headers", () => {
    const out = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("scrubs private key blocks", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    expect(redact(key)).toBe("[redacted private key]");
  });

  it("scrubs .env style assignments", () => {
    expect(redact("DATABASE_PASSWORD=hunter2")).toBe("DATABASE_PASSWORD=[redacted]");
    expect(redact('API_KEY: "sk-live-1234567890abcdef"')).toContain("[redacted]");
  });

  it("scrubs url credentials", () => {
    expect(redact("postgres://user:sekret@db.example.com/app")).toBe("postgres://[redacted]@db.example.com/app");
  });

  it("masks emails", () => {
    expect(redact("contact alice@example.com now")).toBe("contact [redacted email] now");
  });

  it("reduces absolute paths to basenames", () => {
    expect(redact("read /Users/alice/IdeaProjects/secret-project/src/index.ts")).toContain("index.ts");
    expect(redact("read /Users/alice/IdeaProjects/secret-project/src/index.ts")).not.toContain("alice");
  });

  it("adds strict rules only in strict mode", () => {
    const strict = createRedactor({ patterns: "strict" });
    expect(redact("card 4111 1111 1111 1111")).toContain("4111");
    expect(strict("card 4111 1111 1111 1111")).toContain("[redacted card]");
    expect(strict("ssn 123-45-6789")).toContain("[redacted id]");
  });

  it("applies custom patterns", () => {
    const custom = createRedactor({ customPatterns: ["PROJECT-[0-9]{4}"] });
    expect(custom("ticket PROJECT-1234")).toBe("ticket [redacted]");
  });

  it("throws on an invalid custom pattern", () => {
    expect(() => createRedactor({ customPatterns: ["("] })).toThrow(RedactionError);
  });

  it("walks objects and arrays in deep mode", () => {
    const out = redact.deep({ nested: ["alice@example.com", { token: "ghp_012345678901234567890123456789" }] }) as {
      nested: [string, { token: string }];
    };
    expect(out.nested[0]).toBe("[redacted email]");
    expect(out.nested[1].token).toBe("[redacted token]");
  });

  it("survives circular structures", () => {
    const value: Record<string, unknown> = { name: "alice@example.com" };
    value.self = value;
    expect(() => redact.deep(value)).not.toThrow();
  });

  it("redacts a shared node on every branch without cutting it", () => {
    const shared = { token: "ghp_012345678901234567890123456789" };
    const out = redact.deep({ first: shared, second: shared }) as {
      first: { token: string };
      second: { token: string };
    };
    expect(out.first.token).toBe("[redacted token]");
    expect(out.second.token).toBe("[redacted token]");
  });
});
