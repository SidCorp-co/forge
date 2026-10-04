import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgHandleText } from './column-checks.js';
import { users } from './schema-auth.js';
import { organizations } from './schema-orgs.js';
import { projects } from './schema-projects.js';
import { orgMemberRoles, projectMemberRoles } from './schema-vocabulary.js';

export const organizationMembers = pgTable(
  'organization_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: orgMemberRoles }).notNull().default('member'),
    lenses: text('lenses').array().notNull().default(sql`ARRAY[]::text[]`),
    /**
     * The address, the thing typed after `@`. Lowercase, no spaces,
     * machine-read, unique within this org (ISS-1003).
     */
    handle: text('handle'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    userIdIdx: index('organization_members_user_id_idx').on(t.userId),
    orgHandleUnique: uniqueIndex('organization_members_org_handle_uniq')
      .on(t.orgId, t.handle)
      .where(sql`handle IS NOT NULL`),
    handleShape: check('organization_members_handle_shape', orgHandleText(t.handle)),
  }),
);

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.orgId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [organizationMembers.userId], references: [users.id] }),
}));

export const projectMembers = pgTable(
  'project_members',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role', { enum: projectMemberRoles }).notNull().default('member'),
    /** Permissions held on this project beyond the role's (`@forge/contracts/permissions`). */
    grants: text('grants').array().notNull().default(sql`ARRAY[]::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.projectId] }),
    projectIdIdx: index('project_members_project_id_idx').on(t.projectId),
  }),
);

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}));
