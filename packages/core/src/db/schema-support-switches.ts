// A group's switch to the project's channel agent (REQ-77 BC-16..BC-19), owned by the `support`
// domain beside its rooms and channels (`schema-support.ts`), kept apart only for size.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';

/**
 * A group's switch from the bot outside Forge that answers it to the project's channel agent (REQ-77
 * BC-16..BC-19): the outside bot's chat account the switch removes from the group, the duties the
 * agent passes first (each by a person, with what they saw), the earlier switch it waits on until
 * that one is proven, and the owner's word where it is needed. `applying_at` is set while the switch
 * runs, the one moment the binding door lets the group join the agent.
 */
export const supportChannelSwitches = pgTable(
  'support_channel_switches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    rid: text('rid').notNull(),
    outsideBotUserId: text('outside_bot_user_id').notNull(),
    outsideBotUsername: text('outside_bot_username'),
    /** The outside bot answers as the binding's own chat account: the switch removes nobody. */
    outsideIsSelf: boolean('outside_is_self').notNull().default(false),
    /** An operator's record that the outside bot's process is stopped, which a self switch waits on. */
    outsideStoppedAt: timestamp('outside_stopped_at', { withTimezone: true }),
    outsideStoppedBy: uuid('outside_stopped_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    outsideStoppedNote: text('outside_stopped_note'),
    /** `[{ key, text, passedBy, passedAt, evidence }]`, in the order the plan named them. */
    duties: jsonb('duties').notNull(),
    afterSwitchId: uuid('after_switch_id'),
    ownerWordNeeded: boolean('owner_word_needed').notNull().default(false),
    ownerWord: text('owner_word'),
    ownerWordBy: uuid('owner_word_by').references(() => users.id, { onDelete: 'set null' }),
    ownerWordAt: timestamp('owner_word_at', { withTimezone: true }),
    applyingAt: timestamp('applying_at', { withTimezone: true }),
    switchedAt: timestamp('switched_at', { withTimezone: true }),
    switchedBy: uuid('switched_by').references(() => users.id, { onDelete: 'set null' }),
    provenAt: timestamp('proven_at', { withTimezone: true }),
    provenBy: uuid('proven_by').references(() => users.id, { onDelete: 'set null' }),
    provenNote: text('proven_note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectRidUq: uniqueIndex('support_channel_switches_project_rid_uq').on(t.projectId, t.rid),
    afterFk: foreignKey({
      columns: [t.afterSwitchId],
      foreignColumns: [t.id],
      name: 'support_channel_switches_after_fk',
    }).onDelete('restrict'),
    notSelfChk: check(
      'support_channel_switches_not_self_chk',
      sql`${t.afterSwitchId} IS NULL OR ${t.afterSwitchId} <> ${t.id}`,
    ),
  }),
);
