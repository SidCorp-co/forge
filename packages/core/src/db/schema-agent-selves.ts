// An agent's SELF — who it is, how it presents, how it operates and how present
// it is in a room — held once per agent account and rendered into every door
// that speaks as that handle (ISS-1034).
//
// Split out of `schema.ts` only for size; it is a schema module like
// `schema-speaker-links.ts` and is registered in `drizzle.config.ts` and the
// drizzle client's schema map alongside it.

import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema.js';

/** How a handle behaves in a group room it was not summoned into. */
export const answerInGroupModes = ['window', 'mention'] as const;
export type AnswerInGroupMode = (typeof answerInGroupModes)[number];

/**
 * The presence knobs a self may set. Every key is optional; an unset key folds
 * as its default, and the defaults are today's constants in
 * `conversations/proactivity.ts`. Bounds and the per-key fold live in
 * `conversations/presence.ts`, the one reader of this shape.
 */
export interface PresenceConfig {
  dormantMs?: number | undefined;
  backoffAfter?: number | undefined;
  loopBounceMs?: number | undefined;
  loopLimit?: number | undefined;
  answerInGroup?: AnswerInGroupMode | undefined;
  heartbeat?: { enabled?: boolean | undefined; intervalMs?: number | undefined } | undefined;
}

export const agentSelves = pgTable(
  'agent_selves',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who it is: values, voice, what it refuses. Rendered verbatim. */
    soul: text('soul'),
    /** Standing operating instructions, rendered after the method. */
    instructions: text('instructions'),
    /** How it presents: a short emoji or glyph, and the line it opens with. */
    emoji: text('emoji'),
    greeting: text('greeting'),
    presence: jsonb('presence').$type<PresenceConfig>().notNull().default({}),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    updatedIdx: index('agent_selves_updated_idx').on(t.updatedAt),
  }),
);

export const preferenceChangeFields = ['answer_style', 'assistant_instructions'] as const;
export type PreferenceChangeField = (typeof preferenceChangeFields)[number];

export const preferenceChangeActors = ['person', 'admin', 'assistant'] as const;
export type PreferenceChangeActor = (typeof preferenceChangeActors)[number];

export const preferenceChanges = pgTable(
  'preference_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    field: text('field', { enum: preferenceChangeFields }).notNull(),
    previousValue: text('previous_value'),
    newValue: text('new_value'),
    changedBy: text('changed_by', { enum: preferenceChangeActors }).notNull(),
    changedByUserId: uuid('changed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The room the assistant made the change in; null for a person's or an admin's edit. */
    conversationId: uuid('conversation_id'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userChangedIdx: index('preference_changes_user_changed_idx').on(t.userId, t.changedAt),
  }),
);
