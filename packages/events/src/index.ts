import { randomUUID } from "node:crypto";
import { Kafka, logLevel, Partitioners, type Producer } from "kafkajs";

export interface EventBusSettings {
  brokers: string[];
  clientId: string;
  enabled: boolean;
  serviceName: string;
  topicPrefix: string;
}

export interface DomainEvent<TData extends Record<string, unknown> = Record<string, unknown>> {
  data: TData;
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  requestId?: string;
  serviceName: string;
  tenantId?: string;
  userId?: string;
}

export interface CreateDomainEventInput<TData extends Record<string, unknown>> {
  data: TData;
  eventType: string;
  eventVersion?: number;
  requestId?: string;
  serviceName: string;
  tenantId?: string;
  userId?: string;
}

export interface PublishEventInput<TData extends Record<string, unknown>> {
  event: DomainEvent<TData>;
  key?: string;
  topic: string;
}

export interface EventPublisher {
  publish<TData extends Record<string, unknown>>(input: PublishEventInput<TData>): Promise<void>;
  shutdown(): Promise<void>;
}

export function loadEventBusSettings(input: {
  clientId?: string;
  serviceName: string;
  topicPrefix?: string;
}): EventBusSettings {
  return {
    brokers: (process.env.KAFKA_BROKERS ?? "127.0.0.1:9092")
      .split(",")
      .map((broker) => broker.trim())
      .filter(Boolean),
    clientId: process.env.KAFKA_CLIENT_ID ?? input.clientId ?? input.serviceName,
    enabled: process.env.KAFKA_ENABLED === "true",
    serviceName: input.serviceName,
    topicPrefix: normalizeTopicPart(
      process.env.KAFKA_TOPIC_PREFIX ?? input.topicPrefix ?? "knoviq",
    ),
  };
}

export function createEventPublisher(settings: EventBusSettings): EventPublisher {
  if (!settings.enabled || settings.brokers.length === 0) {
    return new DisabledEventPublisher();
  }

  return new KafkaEventPublisher(settings);
}

export function createDomainEvent<TData extends Record<string, unknown>>(
  input: CreateDomainEventInput<TData>,
): DomainEvent<TData> {
  const baseEvent = {
    data: input.data,
    eventId: randomUUID(),
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? 1,
    occurredAt: new Date().toISOString(),
    serviceName: input.serviceName,
  };

  return {
    ...baseEvent,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
  };
}

export function resolveTopic(settings: EventBusSettings, topic: string): string {
  return `${settings.topicPrefix}.${normalizeTopicPart(topic)}`;
}

class DisabledEventPublisher implements EventPublisher {
  async publish(): Promise<void> {
    return;
  }

  async shutdown(): Promise<void> {
    return;
  }
}

class KafkaEventPublisher implements EventPublisher {
  private readonly producer: Producer;
  /**
   * Holds the in-flight connect() promise while connecting.
   * Cleared on failure so the next publish retries the connection.
   * Set to the resolved producer after a successful connect — but
   * also cleared if the producer emits DISCONNECT so the next
   * publish triggers a fresh reconnect.
   */
  private connectPromise: Promise<Producer> | undefined;

  constructor(private readonly settings: EventBusSettings) {
    const kafka = new Kafka({
      brokers: settings.brokers,
      clientId: settings.clientId,
      // Only ERROR-level logs from the Kafka client to avoid noisy INFO in
      // application log streams. Adjust to logLevel.WARN for richer diagnostics.
      logLevel: logLevel.ERROR,
    });

    this.producer = kafka.producer({
      // Only auto-create topics in non-production to prevent typos silently
      // creating phantom topics in a production cluster.
      allowAutoTopicCreation: process.env.NODE_ENV !== "production",
      // LegacyPartitioner is the correct choice in KafkaJS v2 — DefaultPartitioner
      // is deprecated and emits a warning on every producer creation.
      createPartitioner: Partitioners.LegacyPartitioner,
    });

    // When the broker disconnects the producer, reset connectPromise so the
    // next publish call triggers a fresh reconnect instead of hanging on
    // the stale resolved promise.
    this.producer.on("producer.disconnect", () => {
      this.connectPromise = undefined;
    });
  }

  async publish<TData extends Record<string, unknown>>(
    input: PublishEventInput<TData>,
  ): Promise<void> {
    try {
      const producer = await this.connect();
      await producer.send({
        messages: [
          {
            headers: {
              "event-id": input.event.eventId,
              "event-type": input.event.eventType,
              "event-version": String(input.event.eventVersion),
              "service-name": input.event.serviceName,
            },
            key: input.key ?? input.event.tenantId ?? input.event.eventId,
            value: JSON.stringify(input.event),
          },
        ],
        topic: resolveTopic(this.settings, input.topic),
      });
    } catch (error) {
      // Kafka failures must never propagate to the request path.
      // Log at warn level so ops can detect persistent broker issues
      // without crashing user-facing endpoints.
      // Using process.stderr directly avoids importing a logger package here.
      process.stderr.write(
        `[events] Failed to publish ${input.event.eventType} to ${input.topic}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  async shutdown(): Promise<void> {
    if (!this.connectPromise) {
      // Producer was never connected — nothing to disconnect.
      return;
    }

    try {
      // Wait for any in-flight connect to resolve before disconnecting.
      await this.connectPromise;
      await this.producer.disconnect();
    } catch {
      // Best-effort shutdown — ignore errors.
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async connect(): Promise<Producer> {
    // If a valid connectPromise exists (either in-flight or resolved), reuse it.
    // If not (first call, or cleared after disconnect), start a new connection.
    this.connectPromise ??= this.producer
      .connect()
      .then(() => this.producer)
      .catch((error: unknown) => {
        // Clear on failure so the next caller retries.
        this.connectPromise = undefined;
        throw error;
      });

    return this.connectPromise;
  }
}

function normalizeTopicPart(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
