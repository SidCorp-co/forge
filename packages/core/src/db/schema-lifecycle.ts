import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { actorAgencies, kernelTransitionEntities } from './schema-vocabulary.js';

export const kernelTransitionActorTypes = ['user', 'system', 'runner', 'sweeper'] as const;

export type KernelTransitionActorType = (typeof kernelTransitionActorTypes)[number];

// Append-only record of every status move on every machine (`@forge/contracts/machines`), written
// by the one kernel transition `lifecycle/transition.ts:transition` in the move's own transaction:
// one row per moved entity. `from_status` is the status the row actually left (read under the row
// lock); `actor_id` is a bare uuid (no FK), so a system actor records NULL. `from_status` and
// `to_status` are history: they carry no CHECK and keep a state a later machine version retired.
export const kernelTransitions = pgTable(
  'kernel_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entity: text('entity', { enum: kernelTransitionEntities }).notNull(),
    entityId: uuid('entity_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    /** The version of the machine that judged the move (`StatusMachine.version`); null on a row
     *  recorded before machines were versioned. */
    machineVersion: integer('machine_version'),
    reason: text('reason'),
    actorType: text('actor_type', { enum: kernelTransitionActorTypes }).notNull(),
    actorAgency: text('actor_agency', { enum: actorAgencies }).notNull(),
    actorId: uuid('actor_id'),
    /** The credential the move was made with; null for a session or a system actor. */
    actorTokenId: uuid('actor_token_id'),
    /** The person that credential acts for (`personal_access_tokens.on_behalf_of`). */
    actorOnBehalfOf: uuid('actor_on_behalf_of'),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index('kernel_transitions_entity_idx').on(t.entity, t.entityId),
    createdAtIdx: index('kernel_transitions_created_at_idx').on(t.createdAt),
    reasonIdx: index('kernel_transitions_reason_idx').on(t.reason),
  }),
);
