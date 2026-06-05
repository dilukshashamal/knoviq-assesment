import { describe, expect, it } from "vitest";
import type { CacheClient, FixedWindowHit } from "@knoviq/cache";

import { AuthenticatedFixedWindowRateLimiter } from "./rate-limiter.js";

describe("AuthenticatedFixedWindowRateLimiter", () => {
  it("limits requests per tenant user", async () => {
    const limiter = new AuthenticatedFixedWindowRateLimiter(createCache(), {
      maxRequests: 2,
      windowSeconds: 60,
    });
    const input = { routeGroup: "chat", tenantId: "tenant-a", userId: "user-a" };

    await expect(limiter.consume(input)).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(limiter.consume(input)).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(limiter.consume(input)).resolves.toMatchObject({ allowed: false, remaining: 0 });
  });

  it("isolates different users in the same tenant", async () => {
    const limiter = new AuthenticatedFixedWindowRateLimiter(createCache(), {
      maxRequests: 1,
      windowSeconds: 60,
    });

    await limiter.consume({ routeGroup: "chat", tenantId: "tenant-a", userId: "user-a" });

    await expect(
      limiter.consume({ routeGroup: "chat", tenantId: "tenant-a", userId: "user-b" }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("uses cache-backed counters when available", async () => {
    const limiter = new AuthenticatedFixedWindowRateLimiter(
      createCache({
        hitFixedWindow: async () => ({ count: 3, ttlSeconds: 42 }),
      }),
      {
        maxRequests: 2,
        windowSeconds: 60,
      },
    );

    await expect(
      limiter.consume({ routeGroup: "chat", tenantId: "tenant-a", userId: "user-a" }),
    ).resolves.toMatchObject({
      allowed: false,
      count: 3,
      resetAfterSeconds: 42,
    });
  });
});

function createCache(overrides: Partial<CacheClient> = {}): CacheClient {
  return {
    deleteByPattern: async () => 0,
    getJson: async () => undefined,
    hitFixedWindow: async (): Promise<FixedWindowHit | undefined> => undefined,
    setJson: async () => undefined,
    shutdown: async () => undefined,
    ...overrides,
  };
}
