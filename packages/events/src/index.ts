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
  private connectPromise: Promise<Producer> | undefined;

  constructor(private readonly settings: EventBusSettings) {
    const kafka = new Kafka({
      brokers: settings.brokers,
      clientId: settings.clientId,
      logLevel: logLevel.ERROR,
    });

    this.producer = kafka.producer({
      allowAutoTopicCreation: true,
      createPartitioner: Partitioners.DefaultPartitioner,
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
    } catch {
      return;
    }
  }

  async shutdown(): Promise<void> {
    if (!this.connectPromise) {
      return;
    }

    try {
      await this.producer.disconnect();
    } catch {
      return;
    }
  }

  private async connect(): Promise<Producer> {
    this.connectPromise ??= this.producer
      .connect()
      .then(() => this.producer)
      .catch((error: unknown) => {
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
