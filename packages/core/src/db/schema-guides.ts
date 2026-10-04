import { relations } from 'drizzle-orm';
import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { organizations } from './schema-orgs.js';

export const integrationGuides = pgTable(
  'integration_guides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    body: text('body').notNull(),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgProviderUq: uniqueIndex('integration_guides_org_provider_uq').on(t.orgId, t.provider),
  }),
);

export const integrationGuidesRelations = relations(integrationGuides, ({ one }) => ({
  org: one(organizations, {
    fields: [integrationGuides.orgId],
    references: [organizations.id],
  }),
}));
