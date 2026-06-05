import { describe, expect, it } from "vitest";

import {
  createDomainEvent,
  createEventPublisher,
  loadEventBusSettings,
  resolveTopic,
} from "./index.js";

// ── loadEventBusSettings ──────────────────────────────────────────────────────

describe("loadEventBusSettings", () => {
  it("is disabled when KAFKA_ENABLED is not 'true'", () => {
    const original = process.env.KAFKA_ENABLED;
    process.env.KAFKA_ENABLED = "false";
    const settings = loadEventBusSettings({ serviceName: "test-service" });
    expect(settings.enabled).toBe(false);
    if (original !== undefined) process.env.KAFKA_ENABLED = original;
    else delete process.env.KAFKA_ENABLED;
  });

  it("is enabled when KAFKA_ENABLED=true", () => {
    const original = process.env.KAFKA_ENABLED;
    process.env.KAFKA_ENABLED = "true";
    const settings = loadEventBusSettings({ serviceName: "test-service" });
    expect(settings.enabled).toBe(true);
    if (original !== undefined) process.env.KAFKA_ENABLED = original;
    else delete process.env.KAFKA_ENABLED;
  });

  it("splits KAFKA_BROKERS on comma", () => {
    const original = process.env.KAFKA_BROKERS;
    process.env.KAFKA_BROKERS = "broker1:9092,broker2:9092";
    const settings = loadEventBusSettings({ serviceName: "svc" });
    expect(settings.brokers).toEqual(["broker1:9092", "broker2:9092"]);
    if (original !== undefined) process.env.KAFKA_BROKERS = original;
    else delete process.env.KAFKA_BROKERS;
  });

  it("uses serviceName as default clientId", () => {
    const settings = loadEventBusSettings({ serviceName: "my-service" });
    expect(settings.clientId).toBe("my-service");
  });

  it("normalizes topicPrefix to lowercase with dashes", () => {
    const settings = loadEventBusSettings({
      serviceName: "svc",
      topicPrefix: "My App",
    });
    expect(settings.topicPrefix).toBe("my-app");
  });
});

// ── resolveTopic ──────────────────────────────────────────────────────────────

describe("resolveTopic", () => {
  it("combines prefix and topic with a dot", () => {
    const settings = loadEventBusSettings({ serviceName: "svc", topicPrefix: "knoviq" });
    expect(resolveTopic(settings, "conversations")).toBe("knoviq.conversations");
  });

  it("normalizes the topic segment", () => {
    const settings = loadEventBusSettings({ serviceName: "svc", topicPrefix: "knoviq" });
    expect(resolveTopic(settings, "LLM Usage")).toBe("knoviq.llm-usage");
  });
});

// ── createDomainEvent ─────────────────────────────────────────────────────────

describe("createDomainEvent", () => {
  it("assigns a unique eventId for every call", () => {
    const e1 = createDomainEvent({ data: {}, eventType: "test", serviceName: "svc" });
    const e2 = createDomainEvent({ data: {}, eventType: "test", serviceName: "svc" });
    expect(e1.eventId).not.toBe(e2.eventId);
  });

  it("sets eventVersion to 1 by default", () => {
    const event = createDomainEvent({ data: {}, eventType: "test", serviceName: "svc" });
    expect(event.eventVersion).toBe(1);
  });

  it("allows a custom eventVersion", () => {
    const event = createDomainEvent({
      data: {},
      eventType: "test",
      serviceName: "svc",
      eventVersion: 3,
    });
    expect(event.eventVersion).toBe(3);
  });

  it("includes tenantId when provided", () => {
    const event = createDomainEvent({
      data: {},
      eventType: "test",
      serviceName: "svc",
      tenantId: "t1",
    });
    expect(event.tenantId).toBe("t1");
  });

  it("omits tenantId when not provided", () => {
    const event = createDomainEvent({ data: {}, eventType: "test", serviceName: "svc" });
    expect("tenantId" in event).toBe(false);
  });

  it("includes the data payload", () => {
    const data = { conversationId: "conv-123", messageCount: 5 };
    const event = createDomainEvent({
      data,
      eventType: "conversation.created",
      serviceName: "svc",
    });
    expect(event.data).toEqual(data);
  });

  it("sets occurredAt to a valid ISO timestamp", () => {
    const event = createDomainEvent({ data: {}, eventType: "test", serviceName: "svc" });
    expect(() => new Date(event.occurredAt)).not.toThrow();
    expect(new Date(event.occurredAt).getFullYear()).toBeGreaterThanOrEqual(2024);
  });
});

// ── DisabledEventPublisher ─────────────────────────────────────────────────────

describe("DisabledEventPublisher (KAFKA_ENABLED=false)", () => {
  const settings = loadEventBusSettings({ serviceName: "test", topicPrefix: "knoviq" });
  const disabledSettings = { ...settings, enabled: false };
  const publisher = createEventPublisher(disabledSettings);

  it("publish resolves without throwing", async () => {
    const event = createDomainEvent({ data: {}, eventType: "test.event", serviceName: "test" });
    await expect(
      publisher.publish({ event, topic: "test-topic", key: "k1" }),
    ).resolves.toBeUndefined();
  });

  it("shutdown resolves without throwing", async () => {
    await expect(publisher.shutdown()).resolves.toBeUndefined();
  });

  it("multiple publishes succeed silently", async () => {
    const event = createDomainEvent({ data: { x: 1 }, eventType: "x.happened", serviceName: "s" });
    for (let i = 0; i < 5; i++) {
      await expect(publisher.publish({ event, topic: "t", key: `k${i}` })).resolves.toBeUndefined();
    }
  });
});
