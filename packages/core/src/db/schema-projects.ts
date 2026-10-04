import { relations, sql } from 'drizzle-orm';
import { foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { issuePrefixAliases } from './schema-issues.js';
import { organizations } from './schema-orgs.js';
import { projectMembers } from './schema-permissions.js';
import { projectMemberRoles } from './schema-vocabulary.js';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    agentConfig: jsonb('agent_config'),
    issuePrefix: text('issue_prefix'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdIdx: index('projects_org_id_idx').on(t.orgId),
    createdByIdx: index('projects_created_by_idx').on(t.createdBy),
    archivedAtIdx: index('projects_archived_at_idx').on(t.archivedAt),
    issuePrefixFk: foreignKey({
      name: 'projects_issue_prefix_fk',
      columns: [t.id, t.issuePrefix],
      foreignColumns: [issuePrefixAliases.projectId, issuePrefixAliases.prefix],
    }),
  }),
);

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, { fields: [projects.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [projects.createdBy], references: [users.id] }),
  members: many(projectMembers),
}));

export const projectInvitations = pgTable(
  'project_invitations',
  {
    token: text('token').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: projectMemberRoles }).notNull(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectEmailIdx: index('project_invitations_project_email_idx').on(t.projectId, t.email),
    projectEmailPendingUq: uniqueIndex('project_invitations_project_email_pending_uq')
      .on(t.projectId, t.email)
      .where(sql`accepted_at IS NULL`),
  }),
);

export const projectInvitationsRelations = relations(projectInvitations, ({ one }) => ({
  project: one(projects, {
    fields: [projectInvitations.projectId],
    references: [projects.id],
  }),
  inviter: one(users, {
    fields: [projectInvitations.inviterId],
    references: [users.id],
  }),
}));
