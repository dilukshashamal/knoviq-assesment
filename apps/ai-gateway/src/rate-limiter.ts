import type { CacheClient } from "@knoviq/cache";

export interface AuthenticatedRateLimitInput {
  routeGroup: string;
  tenantId: string;
  userId: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  resetAfterSeconds: number;
}

export interface AuthenticatedRateLimiterSettings {
  maxRequests: number;
  windowSeconds: number;
}

interface MemoryWindow {
  count: number;
  resetAtMs: number;
}

export class AuthenticatedFixedWindowRateLimiter {
  private readonly memoryHits = new Map<string, MemoryWindow>();
  private lastCleanupAtMs = 0;

  constructor(
    private readonly cache: CacheClient,
    private readonly settings: AuthenticatedRateLimiterSettings,
  ) {}

  async consume(input: AuthenticatedRateLimitInput): Promise<RateLimitDecision> {
    const key = buildRateLimitKey(input);
    const cacheHit = await this.cache.hitFixedWindow(key, this.settings.windowSeconds);
    const hit = cacheHit ?? this.hitMemory(key);

    return {
      allowed: hit.count <= this.settings.maxRequests,
      count: hit.count,
      limit: this.settings.maxRequests,
      remaining: Math.max(this.settings.maxRequests - hit.count, 0),
      resetAfterSeconds: hit.ttlSeconds,
    };
  }

  private hitMemory(key: string) {
    const now = Date.now();
    const resetAfterMs = this.settings.windowSeconds * 1000;
    const existing = this.memoryHits.get(key);

    if (now - this.lastCleanupAtMs > resetAfterMs) {
      this.cleanupExpiredWindows(now);
    }

    if (!existing || existing.resetAtMs <= now) {
      const next = {
        count: 1,
        resetAtMs: now + resetAfterMs,
      };
      this.memoryHits.set(key, next);

      return {
        count: next.count,
        ttlSeconds: this.settings.windowSeconds,
      };
    }

    existing.count += 1;

    return {
      count: existing.count,
      ttlSeconds: Math.max(Math.ceil((existing.resetAtMs - now) / 1000), 1),
    };
  }

  private cleanupExpiredWindows(now: number): void {
    for (const [key, window] of this.memoryHits.entries()) {
      if (window.resetAtMs <= now) {
        this.memoryHits.delete(key);
      }
    }

    this.lastCleanupAtMs = now;
  }
}

function buildRateLimitKey(input: AuthenticatedRateLimitInput): string {
  return [
    "rate-limit",
    "llm",
    normalizeKeyPart(input.routeGroup),
    normalizeKeyPart(input.tenantId),
    normalizeKeyPart(input.userId),
  ].join(":");
}

function normalizeKeyPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
