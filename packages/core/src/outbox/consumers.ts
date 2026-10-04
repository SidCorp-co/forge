import type { OutboxEventPayload, OutboxEventType } from '@forge/contracts/outbox-events';

/** The delivery as a consumer sees it: the row's id makes a consumer's own write idempotent. */
export interface Delivery {
  eventId: string;
  createdAt: Date;
}

export interface Consumer<T extends OutboxEventType> {
  /** Unique per type; `pipeline_outbox.delivered` records it once this consumer is through. */
  name: string;
  handle: (payload: OutboxEventPayload<T>, delivery: Delivery) => Promise<void> | void;
  /** Runs once when the event is given up on with this consumer still failing. */
  onDeadLetter?: (
    payload: OutboxEventPayload<T>,
    error: string,
    delivery: Delivery,
  ) => Promise<void>;
}

type AnyConsumer = Consumer<OutboxEventType>;

const registry = new Map<OutboxEventType, AnyConsumer[]>();

/** Registers a consumer of one event type. A second consumer under one name is refused by name. */
export function consume<T extends OutboxEventType>(type: T, consumer: Consumer<T>): void {
  const list = registry.get(type) ?? [];
  if (list.some((c) => c.name === consumer.name)) {
    throw new Error(`outbox: \`${type}\` already has a consumer named \`${consumer.name}\``);
  }
  list.push(consumer as unknown as AnyConsumer);
  registry.set(type, list);
}

export function consumersOf(type: OutboxEventType): readonly AnyConsumer[] {
  return registry.get(type) ?? [];
}
