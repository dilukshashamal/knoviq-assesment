import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export interface CacheSettings {
  defaultTtlSeconds: number;
  enabled: boolean;
  keyPrefix: string;
  redisUrl: string;
}

export interface CacheClient {
  deleteByPattern(pattern: string): Promise<number>;
  getJson<T>(key: string): Promise<T | undefined>;
  hitFixedWindow(key: string, windowSeconds: number): Promise<FixedWindowHit | undefined>;
  setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  shutdown(): Promise<void>;
}

export interface FixedWindowHit {
  count: number;
  ttlSeconds: number;
}

export function loadCacheSettings(
  input: {
    defaultTtlSeconds?: number;
    keyPrefix?: string;
  } = {},
): CacheSettings {
  return {
    defaultTtlSeconds: Number(
      process.env.CACHE_DEFAULT_TTL_SECONDS ?? input.defaultTtlSeconds ?? 60,
    ),
    enabled: process.env.REDIS_ENABLED !== "false",
    keyPrefix: normalizeKeyPart(process.env.CACHE_KEY_PREFIX ?? input.keyPrefix ?? "knoviq"),
    redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  };
}

export function createCacheClient(settings: CacheSettings): CacheClient {
  if (!settings.enabled) {
    return new DisabledCacheClient();
  }

  return new RedisCacheClient(settings);
}

export function createCacheKey(namespace: string, parts: Record<string, unknown>): string {
  const stableParts = stableStringify(parts);
  const digest = createHash("sha256").update(stableParts).digest("hex");
  return `${normalizeKeyPart(namespace)}:${digest}`;
}

export function withCachePrefix(settings: CacheSettings, key: string): string {
  return `${settings.keyPrefix}:${key}`;
}

class DisabledCacheClient implements CacheClient {
  async deleteByPattern(): Promise<number> {
    return 0;
  }

  async getJson<T>(): Promise<T | undefined> {
    return undefined;
  }

  async hitFixedWindow(): Promise<FixedWindowHit | undefined> {
    return undefined;
  }

  async setJson(): Promise<void> {
    return;
  }

  async shutdown(): Promise<void> {
    return;
  }
}

class RedisCacheClient implements CacheClient {
  private readonly client: RedisClientType;
  private connectPromise: Promise<RedisClientType> | undefined;

  constructor(private readonly settings: CacheSettings) {
    this.client = createClient({
      url: settings.redisUrl,
    }) as RedisClientType;

    // Log Redis errors at warn level so ops can detect broker issues.
    // Operations degrade to cache misses — never crash the request path.
    this.client.on("error", (err: unknown) => {
      process.stderr.write(
        `[cache] Redis error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });

    // When the client reconnects after a drop, reset connectPromise so the
    // next operation gets a fresh reference to the now-open client.
    this.client.on("ready", () => {
      // Client is open — ensure subsequent calls use the live connection.
      this.connectPromise = undefined;
    });
  }

  async deleteByPattern(pattern: string): Promise<number> {
    try {
      const client = await this.connect();
      const keys: string[] = [];

      for await (const key of client.scanIterator({
        MATCH: withCachePrefix(this.settings, pattern),
        COUNT: 100,
      })) {
        keys.push(String(key));
      }

      if (keys.length === 0) {
        return 0;
      }

      return Number(await client.unlink(keys));
    } catch {
      return 0;
    }
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    try {
      const client = await this.connect();
      const value = await client.get(withCachePrefix(this.settings, key));

      if (!value) {
        return undefined;
      }

      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  async hitFixedWindow(
    key: string,
    windowSeconds: number,
  ): Promise<FixedWindowHit | undefined> {
    if (windowSeconds <= 0) {
      return undefined;
    }

    try {
      const client = await this.connect();
      const prefixedKey = withCachePrefix(this.settings, key);
      const count = Number(await client.incr(prefixedKey));
      let ttlSeconds = Number(await client.ttl(prefixedKey));

      if (ttlSeconds <= 0) {
        await client.expire(prefixedKey, windowSeconds);
        ttlSeconds = windowSeconds;
      }

      return { count, ttlSeconds };
    } catch {
      return undefined;
    }
  }

  async setJson(
    key: string,
    value: unknown,
    ttlSeconds = this.settings.defaultTtlSeconds,
  ): Promise<void> {
    if (ttlSeconds <= 0) {
      return;
    }

    try {
      const client = await this.connect();
      await client.set(withCachePrefix(this.settings, key), JSON.stringify(value), {
        EX: ttlSeconds,
      });
    } catch {
      return;
    }
  }

  async shutdown(): Promise<void> {
    if (!this.client.isOpen) {
      return;
    }

    await this.client.quit();
  }

  private async connect(): Promise<RedisClientType> {
    // If the client is already open, use it directly.
    if (this.client.isOpen) {
      return this.client;
    }

    // Otherwise initiate a new connection. The ?= ensures only one
    // concurrent connect attempt runs at a time. On failure the promise
    // is cleared so the next caller retries.
    this.connectPromise ??= this.client
      .connect()
      .then(() => this.client)
      .catch((error: unknown) => {
        this.connectPromise = undefined;
        throw error;
      });
    return this.connectPromise;
  }
}

function normalizeKeyPart(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableStringify(nestedValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}
