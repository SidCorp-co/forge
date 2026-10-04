import {
  type OutboxConsumerName,
  type OutboxConsumerOf,
  OUTBOX_CONSUMERS,
} from '@forge/contracts/outbox-consumers';
import {
  OUTBOX_EVENT_TYPES,
  type OutboxEventPayload,
  type OutboxEventType,
} from '@forge/contracts/outbox-events';
import type { Db } from '../db/client.js';

export type DeliveryTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** One delivery of one event to one consumer, as the consumer sees it. */
export interface Delivery {
  id: string;
  eventId: string;
  createdAt: Date;
  /** 1 on the first start, counting every start since (a crash included). */
  attempt: number;
  /**
   * Runs `write` in one transaction with the completion of this delivery's pg-boss job, so the
   * consumer's rows and the completion commit together and a redelivery after the commit finds
   * nothing to do. A consumer whose effect is rows writes them here; one whose effect leaves the
   * database (a push, a queue send) is completed by pg-boss once `handle` returns, and is delivered
   * at least once.
   */
  inbox: <R>(write: (tx: DeliveryTx) => Promise<R>) => Promise<R>;
}

export interface Consumer<T extends OutboxEventType> {
  name: OutboxConsumerOf<T>;
  handle: (payload: OutboxEventPayload<T>, delivery: Delivery) => Promise<void> | void;
  /**
   * Runs once when this consumer's delivery goes `dead`, to settle a row of the consumer's own that
   * would otherwise wait on it for ever. The alert is the outbox's, not this hook's.
   */
  onDeadLetter?: (payload: OutboxEventPayload<T>, error: string, delivery: Delivery) => Promise<void>;
}

type AnyConsumer = {
  name: string;
  handle: (payload: unknown, delivery: Delivery) => Promise<void> | void;
  onDeadLetter?: (payload: unknown, error: string, delivery: Delivery) => Promise<void>;
};

const registry = new Map<OutboxEventType, Map<string, AnyConsumer>>();

/**
 * Registers a consumer of one event type under a name `OUTBOX_CONSUMERS` declares for it. A second
 * consumer under one name is refused by name.
 */
export function consume<T extends OutboxEventType>(type: T, consumer: Consumer<T>): void {
  const byName = registry.get(type) ?? new Map<string, AnyConsumer>();
  if (byName.has(consumer.name)) {
    throw new Error(`outbox: \`${type}\` already has a consumer named \`${consumer.name}\``);
  }
  byName.set(consumer.name, consumer as unknown as AnyConsumer);
  registry.set(type, byName);
}

export function consumerOf(type: OutboxEventType, name: string): AnyConsumer | undefined {
  return registry.get(type)?.get(name);
}

/**
 * Each disagreement between the registered consumers and `OUTBOX_CONSUMERS`: a declared consumer
 * nobody registered would leave its deliveries pending until they die, and a registered one nobody
 * declared would never be handed a delivery.
 */
export function registryMismatches(): string[] {
  const out: string[] = [];
  for (const type of OUTBOX_EVENT_TYPES) {
    const declared = new Set<string>(OUTBOX_CONSUMERS[type] as readonly OutboxConsumerName[]);
    const registered = new Set(registry.get(type)?.keys() ?? []);
    for (const name of declared) {
      if (!registered.has(name)) out.push(`\`${type}\` declares \`${name}\`, and nothing registered it`);
    }
    for (const name of registered) {
      if (!declared.has(name)) out.push(`\`${name}\` consumes \`${type}\`, and OUTBOX_CONSUMERS does not declare it`);
    }
  }
  return out;
}
