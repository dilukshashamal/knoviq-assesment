/**
 * Web app unit tests.
 *
 * Tests cover pure helper functions from lib/session.ts:
 *   - threadStorageKey — per-user localStorage key generation
 *   - isAdminRole — role-based access control check
 *
 * readStoredSession() is not tested here because it depends on
 * browser localStorage (window.localStorage), which is a DOM API
 * not available in the Node.js Vitest environment.
 */
import { describe, expect, it } from "vitest";

import { threadStorageKey, isAdminRole, SESSION_STORAGE_KEY } from "./session.js";

// ── SESSION_STORAGE_KEY ───────────────────────────────────────────────────────

describe("SESSION_STORAGE_KEY", () => {
  it("is a non-empty string constant", () => {
    expect(typeof SESSION_STORAGE_KEY).toBe("string");
    expect(SESSION_STORAGE_KEY.length).toBeGreaterThan(0);
  });

  it("contains 'knoviq' namespace prefix", () => {
    expect(SESSION_STORAGE_KEY).toContain("knoviq");
  });
});

// ── threadStorageKey ──────────────────────────────────────────────────────────

describe("threadStorageKey", () => {
  it("includes the userId in the key", () => {
    const key = threadStorageKey("user-abc-123");
    expect(key).toContain("user-abc-123");
  });

  it("includes the 'knoviq' namespace", () => {
    expect(threadStorageKey("u1")).toContain("knoviq");
  });

  it("produces different keys for different userIds", () => {
    expect(threadStorageKey("user-1")).not.toBe(threadStorageKey("user-2"));
  });

  it("produces the same key for the same userId", () => {
    expect(threadStorageKey("user-x")).toBe(threadStorageKey("user-x"));
  });

  it("is isolated from the session key", () => {
    const threadKey = threadStorageKey("some-user");
    expect(threadKey).not.toBe(SESSION_STORAGE_KEY);
  });

  it("is a deterministic function of userId", () => {
    const ids = ["alice", "bob", "charlie", "user-123"];
    for (const id of ids) {
      expect(threadStorageKey(id)).toBe(threadStorageKey(id));
    }
  });
});

// ── isAdminRole ───────────────────────────────────────────────────────────────

describe("isAdminRole", () => {
  it("returns true for 'admin' role", () => {
    expect(isAdminRole("admin")).toBe(true);
  });

  it("returns true for 'owner' role", () => {
    expect(isAdminRole("owner")).toBe(true);
  });

  it("returns false for 'member' role", () => {
    expect(isAdminRole("member")).toBe(false);
  });

  it("returns false for 'viewer' role", () => {
    expect(isAdminRole("viewer")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isAdminRole("")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAdminRole(undefined)).toBe(false);
  });

  it("is case-sensitive — 'Admin' is not admin", () => {
    expect(isAdminRole("Admin")).toBe(false);
  });

  it("returns false for any unknown role", () => {
    const unknownRoles = ["superuser", "root", "moderator", "guest"];
    for (const role of unknownRoles) {
      expect(isAdminRole(role)).toBe(false);
    }
  });
});
