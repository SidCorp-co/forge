import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { projects } from './schema-projects.js';

export const appConfig = pgTable('app_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  chatProviderId: text('chat_provider_id'),
  chatModel: text('chat_model'),
  /** `{ [ChatTurnKind]: model }` — a per-kind model on the same provider; a missing kind falls to `chatModel`. */
  chatModelByKind: jsonb('chat_model_by_kind').notNull().default(sql`'{}'::jsonb`),
  retrievalRerank: boolean('retrieval_rerank').notNull().default(false),
  retrievalExpandRelations: boolean('retrieval_expand_relations').notNull().default(false),
  systemPromptOverride: text('system_prompt_override'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appConfigRelations = relations(appConfig, ({ one }) => ({
  project: one(projects, { fields: [appConfig.projectId], references: [projects.id] }),
}));
