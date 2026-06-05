/**
 * Auth service unit tests.
 *
 * Tests cover pure functions that have no external dependencies:
 *   - Zod validation schemas (RegisterRequest, LoginRequest, etc.)
 *   - Refresh token helpers (createOpaqueRefreshToken, hashRefreshToken, getRefreshTokenExpiry)
 *   - Password hashing and verification (argon2id)
 *
 * These run entirely in-process with no database, Redis, or Kafka required.
 */
import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password.js";
import {
  createOpaqueRefreshToken,
  hashRefreshToken,
  getRefreshTokenExpiry,
} from "./refresh-token.js";
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  RefreshTokenRequestSchema,
} from "./schemas.js";

// ── RegisterRequestSchema ─────────────────────────────────────────────────────

describe("RegisterRequestSchema", () => {
  const valid = {
    email: "user@example.com",
    password: "StrongPassword1!",
  };

  it("accepts a valid registration request", () => {
    const result = RegisterRequestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("normalizes email to lowercase", () => {
    const result = RegisterRequestSchema.safeParse({ ...valid, email: "User@Example.COM" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("user@example.com");
  });

  it("rejects invalid email format", () => {
    expect(RegisterRequestSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
  });

  it("rejects password shorter than 12 characters", () => {
    expect(RegisterRequestSchema.safeParse({ ...valid, password: "short" }).success).toBe(false);
  });

  it("accepts optional fullName and tenantName", () => {
    const result = RegisterRequestSchema.safeParse({
      ...valid,
      fullName: "Alice",
      tenantName: "Acme Corp",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fullName).toBe("Alice");
      expect(result.data.tenantName).toBe("Acme Corp");
    }
  });

  it("trims whitespace from email", () => {
    const result = RegisterRequestSchema.safeParse({ ...valid, email: "  user@example.com  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("user@example.com");
  });
});

// ── LoginRequestSchema ────────────────────────────────────────────────────────

describe("LoginRequestSchema", () => {
  const valid = { email: "user@example.com", password: "any-password" };

  it("accepts a valid login request", () => {
    expect(LoginRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("normalizes email to lowercase", () => {
    const result = LoginRequestSchema.safeParse({ ...valid, email: "ADMIN@EXAMPLE.COM" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("admin@example.com");
  });

  it("rejects empty password", () => {
    expect(LoginRequestSchema.safeParse({ ...valid, password: "" }).success).toBe(false);
  });

  it("rejects missing email", () => {
    expect(LoginRequestSchema.safeParse({ password: "pass" }).success).toBe(false);
  });
});

// ── RefreshTokenRequestSchema ─────────────────────────────────────────────────

describe("RefreshTokenRequestSchema", () => {
  it("accepts a token with 32+ characters", () => {
    expect(
      RefreshTokenRequestSchema.safeParse({ refreshToken: "a".repeat(32) }).success,
    ).toBe(true);
  });

  it("rejects a token shorter than 32 characters", () => {
    expect(
      RefreshTokenRequestSchema.safeParse({ refreshToken: "short" }).success,
    ).toBe(false);
  });
});

// ── Refresh token helpers ─────────────────────────────────────────────────────

describe("createOpaqueRefreshToken", () => {
  it("returns a non-empty string", () => {
    const token = createOpaqueRefreshToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("returns different tokens on each call", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => createOpaqueRefreshToken()));
    expect(tokens.size).toBe(20);
  });

  it("returns a URL-safe base64 string (no +, /, =)", () => {
    for (let i = 0; i < 10; i++) {
      const token = createOpaqueRefreshToken();
      expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
    }
  });
});

describe("hashRefreshToken", () => {
  it("produces a 64-char hex digest", () => {
    const hash = hashRefreshToken("some-token", "secret");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    const h1 = hashRefreshToken("tok", "secret");
    const h2 = hashRefreshToken("tok", "secret");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different tokens", () => {
    expect(hashRefreshToken("tok1", "secret")).not.toBe(hashRefreshToken("tok2", "secret"));
  });

  it("produces different hashes for different secrets", () => {
    expect(hashRefreshToken("tok", "secret1")).not.toBe(hashRefreshToken("tok", "secret2"));
  });
});

describe("getRefreshTokenExpiry", () => {
  it("returns a Date in the future", () => {
    const expiry = getRefreshTokenExpiry(3600);
    expect(expiry.getTime()).toBeGreaterThan(Date.now());
  });

  it("expiry is approximately ttlSeconds from now", () => {
    const before = Date.now();
    const expiry = getRefreshTokenExpiry(3600);
    const diff = expiry.getTime() - before;
    expect(diff).toBeGreaterThan(3590 * 1000);
    expect(diff).toBeLessThan(3610 * 1000);
  });
});

// ── Password hashing (argon2id) ───────────────────────────────────────────────

describe("hashPassword / verifyPassword", () => {
  it("hashes a password and verifies it correctly", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    const valid = await verifyPassword(hash, "correct-horse-battery-staple");
    expect(valid).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    const invalid = await verifyPassword(hash, "wrong-password");
    expect(invalid).toBe(false);
  });

  it("produces different hashes for the same password (salt randomness)", async () => {
    const h1 = await hashPassword("same-password-123");
    const h2 = await hashPassword("same-password-123");
    expect(h1).not.toBe(h2);
  });

  it("verifyPassword returns false for an obviously malformed hash", async () => {
    const result = await verifyPassword("not-a-valid-hash", "anything");
    expect(result).toBe(false);
  });
}, 30_000); // argon2 is intentionally slow — allow 30s for 4 tests
