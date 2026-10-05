import { relations, sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { organizationMembers } from './schema-permissions.js';
import { projects } from './schema-projects.js';
import { orgMemberRoles } from './schema-vocabulary.js';

export const memberLenses = ['technical', 'product'] as const;

export type MemberLens = (typeof memberLenses)[number];

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    isPersonal: boolean('is_personal').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    personalOwnerUq: uniqueIndex('organizations_personal_owner_uq')
      .on(t.createdBy)
      .where(sql`is_personal = true`),
  }),
);

export const orgInvitations = pgTable(
  'org_invitations',
  {
    tokenHash: text('token_hash').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: orgMemberRoles }).notNull(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgEmailIdx: index('org_invitations_org_email_idx').on(t.orgId, t.email),
    orgEmailPendingUq: uniqueIndex('org_invitations_org_email_pending_uq')
      .on(t.orgId, t.email)
      .where(sql`accepted_at IS NULL`),
  }),
);

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  creator: one(users, { fields: [organizations.createdBy], references: [users.id] }),
  members: many(organizationMembers),
  projects: many(projects),
}));
