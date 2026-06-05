import { describe, expect, it } from "vitest";

import { createCacheKey, createCacheClient, loadCacheSettings, withCachePrefix } from "./index.js";

// ── loadCacheSettings ─────────────────────────────────────────────────────────

describe("loadCacheSettings", () => {
  it("returns disabled client when REDIS_ENABLED=false", () => {
    const original = process.env.REDIS_ENABLED;
    process.env.REDIS_ENABLED = "false";
    const settings = loadCacheSettings();
    expect(settings.enabled).toBe(false);
    process.env.REDIS_ENABLED = original;
  });

  it("defaults to enabled when REDIS_ENABLED is not set", () => {
    const original = process.env.REDIS_ENABLED;
    delete process.env.REDIS_ENABLED;
    const settings = loadCacheSettings();
    expect(settings.enabled).toBe(true);
    if (original !== undefined) process.env.REDIS_ENABLED = original;
  });

  it("uses CACHE_KEY_PREFIX env var when set", () => {
    const original = process.env.CACHE_KEY_PREFIX;
    process.env.CACHE_KEY_PREFIX = "myapp";
    const settings = loadCacheSettings();
    expect(settings.keyPrefix).toBe("myapp");
    if (original !== undefined) process.env.CACHE_KEY_PREFIX = original;
    else delete process.env.CACHE_KEY_PREFIX;
  });

  it("uses input.keyPrefix as fallback", () => {
    const original = process.env.CACHE_KEY_PREFIX;
    delete process.env.CACHE_KEY_PREFIX;
    const settings = loadCacheSettings({ keyPrefix: "fallback" });
    expect(settings.keyPrefix).toBe("fallback");
    if (original !== undefined) process.env.CACHE_KEY_PREFIX = original;
  });

  it("normalizes key prefix to lowercase with dashes", () => {
    const original = process.env.CACHE_KEY_PREFIX;
    process.env.CACHE_KEY_PREFIX = "My App Key";
    const settings = loadCacheSettings();
    expect(settings.keyPrefix).toBe("my-app-key");
    if (original !== undefined) process.env.CACHE_KEY_PREFIX = original;
    else delete process.env.CACHE_KEY_PREFIX;
  });
});

// ── createCacheKey ────────────────────────────────────────────────────────────

describe("createCacheKey", () => {
  it("produces a deterministic hash for the same inputs", () => {
    const key1 = createCacheKey("ns", { a: 1, b: 2 });
    const key2 = createCacheKey("ns", { a: 1, b: 2 });
    expect(key1).toBe(key2);
  });

  it("produces different hashes for different inputs", () => {
    const key1 = createCacheKey("ns", { a: 1 });
    const key2 = createCacheKey("ns", { a: 2 });
    expect(key1).not.toBe(key2);
  });

  it("is order-independent for object keys", () => {
    const key1 = createCacheKey("ns", { a: 1, b: 2 });
    const key2 = createCacheKey("ns", { b: 2, a: 1 });
    expect(key1).toBe(key2);
  });

  it("includes the namespace in the key", () => {
    const key = createCacheKey("my-namespace", { x: 1 });
    expect(key.startsWith("my-namespace:")).toBe(true);
  });

  it("produces different keys for different namespaces", () => {
    const key1 = createCacheKey("ns1", { a: 1 });
    const key2 = createCacheKey("ns2", { a: 1 });
    expect(key1).not.toBe(key2);
  });

  it("handles nested objects", () => {
    const key1 = createCacheKey("ns", { query: "hello", filters: { status: "ready" } });
    const key2 = createCacheKey("ns", { query: "hello", filters: { status: "ready" } });
    expect(key1).toBe(key2);
  });

  it("handles array values", () => {
    const key1 = createCacheKey("ns", { ids: ["a", "b", "c"] });
    const key2 = createCacheKey("ns", { ids: ["a", "b", "c"] });
    expect(key1).toBe(key2);
  });

  it("null values produce a deterministic key", () => {
    const key1 = createCacheKey("ns", { ids: null });
    const key2 = createCacheKey("ns", { ids: null });
    expect(key1).toBe(key2);
  });
});

// ── withCachePrefix ───────────────────────────────────────────────────────────

describe("withCachePrefix", () => {
  it("prepends the key prefix", () => {
    const settings = loadCacheSettings({ keyPrefix: "knoviq" });
    const prefixed = withCachePrefix(settings, "my-key");
    expect(prefixed).toBe("knoviq:my-key");
  });
});

// ── DisabledCacheClient (via createCacheClient with enabled=false) ─────────────

describe("DisabledCacheClient", () => {
  const settings = loadCacheSettings({ keyPrefix: "test" });
  const disabledSettings = { ...settings, enabled: false };
  const client = createCacheClient(disabledSettings);

  it("getJson returns undefined", async () => {
    expect(await client.getJson("any-key")).toBeUndefined();
  });

  it("setJson completes without throwing", async () => {
    await expect(client.setJson("any-key", { value: 42 })).resolves.toBeUndefined();
  });

  it("deleteByPattern returns 0", async () => {
    expect(await client.deleteByPattern("*")).toBe(0);
  });

  it("hitFixedWindow returns undefined", async () => {
    expect(await client.hitFixedWindow("key", 60)).toBeUndefined();
  });

  it("shutdown completes without throwing", async () => {
    await expect(client.shutdown()).resolves.toBeUndefined();
  });
});
