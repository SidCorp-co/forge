import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { organizations } from './schema-orgs.js';

/** How a person wants the assistant to answer them, on every surface (ISS-1034). */
export const answerStyles = ['default', 'concise', 'detailed', 'bullets'] as const;

export type AnswerStyle = (typeof answerStyles)[number];

export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  theme: text('theme').notNull().default('system'),
  language: text('language').notNull().default('en'),
  /**
   * False suppresses in-app `mention` deliveries (gated in `notifications/deliver.ts#wantsDelivery`,
   * ISS-1063: the record is the system's account of what happened and stands either way).
   * `mention` is the only user-initiated type produced, so it is the only opt-out
   * offered — no controls for channels that do not exist.
   */
  notifyOnMention: boolean('notify_on_mention').notNull().default(true),
  /**
   * The org being "worked in" (ISS-469). Null means no explicit choice and the
   * client resolves it to the personal org; `set null` on org delete so a removed
   * org clears the pointer rather than blocking the delete or dangling.
   */
  activeOrgId: uuid('active_org_id').references(() => organizations.id, {
    onDelete: 'set null',
  }),
  /**
   * How the assistant answers this person, read on every turn for the linked
   * speaker whichever door they came through (ISS-1034). Per person, never per
   * room or per project.
   */
  answerStyle: text('answer_style', { enum: answerStyles }).notNull().default('default'),
  /** Free text the person wants every reply to honour — what to always include, never repeat. */
  assistantInstructions: text('assistant_instructions'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
