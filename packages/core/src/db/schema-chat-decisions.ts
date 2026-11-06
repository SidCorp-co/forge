import type { ChatDecisionSetItem } from '@forge/contracts/chat-decide';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { conversations } from './schema-conversations.js';
import { projects } from './schema-projects.js';

/** Where a refused decision act came from: a card the person pressed, or the chat acting on their word. */
export const CHAT_DECISION_FAILURE_VIAS = ['card', 'chat'] as const;
export type ChatDecisionFailureVia = (typeof CHAT_DECISION_FAILURE_VIAS)[number];

// The Needs-you decisions a chat puts to the person and the acts on them that were refused (REQ-41
// BC-25, BC-27, BC-28; ISS-624), owned by the `assistant` domain (`assistant/decision-acts.ts`).
// A set is what the person agrees with "open them": `act_on_decisions` acts on the newest set put in
// an earlier turn, whole, so the model can neither widen nor narrow it. `window_id` is the turn that
// put it, which the act refuses to be in. Rows are written once.

export const chatDecisionSets = pgTable(
  'chat_decision_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The person it was put to: the one the turn answered. */
    personId: uuid('person_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    windowId: uuid('window_id').notNull(),
    items: jsonb('items').$type<ChatDecisionSetItem[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversationIdx: index('chat_decision_sets_conversation_idx').on(t.conversationId, t.createdAt),
    itemsChk: check(
      'chat_decision_sets_items_chk',
      sql`jsonb_typeof(${t.items}) = 'array' AND jsonb_array_length(${t.items}) > 0`,
    ),
  }),
);

// Each refused act on one decision in a conversation: a card press the browser reported failed with
// core's refusal, or an `act_on_decisions` item core refused (DECISION_REFUSED). Two on one decision
// and it is not offered a third time, and Forge's own feedback records it (`feedback_key`).
export const chatDecisionFailures = pgTable(
  'chat_decision_failures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The Needs-you decision id the act answered. */
    decisionId: text('decision_id').notNull(),
    /** The decision row's key, as the person reads it. */
    itemKey: text('item_key').notNull(),
    via: text('via', { enum: CHAT_DECISION_FAILURE_VIAS }).notNull(),
    code: text('code').notNull(),
    detail: text('detail').notNull(),
    /** The Forge feedback item the defect was filed as, on the refusal that made it twice. */
    feedbackKey: text('feedback_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    decisionIdx: index('chat_decision_failures_decision_idx').on(t.conversationId, t.decisionId),
    viaChk: check('chat_decision_failures_via_chk', sql`${t.via} IN ('card', 'chat')`),
  }),
);
