import { COMMENT_EVENT_KINDS, type DecisionFields } from '@forge/contracts/comments';
import { COMMENT_INTENTS } from '@forge/contracts/record-events';
import { WRITTEN_LANGS } from '@forge/contracts/written-lang';
import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { BODY_FORMATS } from '../body/formats.js';
import { users } from './schema-auth.js';
import { devices } from './schema-devices.js';
import { feedback } from './schema-feedback.js';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';
import { requirements } from './schema-requirements.js';
import { projectWorkflows } from './schema-workflows.js';

// a comment sits on exactly one target (ISS-83): an exclusive arc of real foreign keys,
// each cascading with its target, held by comments_scope_chk so no door can write an orphan or a twin
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    requirementId: uuid('requirement_id').references((): AnyPgColumn => requirements.id, {
      onDelete: 'cascade',
    }),
    workflowId: uuid('workflow_id').references((): AnyPgColumn => projectWorkflows.id, {
      onDelete: 'cascade',
    }),
    feedbackId: uuid('feedback_id').references((): AnyPgColumn => feedback.id, {
      onDelete: 'cascade',
    }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    authorDeviceId: uuid('author_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    format: text('format', { enum: BODY_FORMATS }).notNull().default('markdown'),
    stage: text('stage'),
    parentId: uuid('parent_id'),
    /**
     * ISS-56 — what the comment means to do: `question` is owed a reply, `decision` is pinned,
     * `note` is neither. The REST and MCP doors decide it by name; the default is what a system
     * write that declares nothing means.
     */
    intent: text('intent', { enum: COMMENT_INTENTS }).notNull().default('note'),
    decision: jsonb('decision').$type<DecisionFields>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** The language the text was written in (`@forge/contracts/written-lang`); null where it was written before the language was stored. */
    writtenLang: text('written_lang', { enum: WRITTEN_LANGS }),
  },
  (t) => ({
    writtenLangChk: check(
      'comments_written_lang_chk',
      sql`${t.writtenLang} IS NULL OR ${t.writtenLang} IN ('en', 'vi')`,
    ),
    formatChk: check('comments_format_chk', sql`${t.format} IN ('markdown', 'html')`),
    intentChk: check('comments_intent_chk', sql`${t.intent} IN ('question', 'decision', 'note')`),
    scopeChk: check(
      'comments_scope_chk',
      sql`num_nonnulls(${t.issueId}, ${t.requirementId}, ${t.workflowId}, ${t.feedbackId}) = 1`,
    ),
    decisionIntentChk: check(
      'comments_decision_intent_chk',
      sql`${t.decision} IS NULL OR ${t.intent} = 'decision'`,
    ),
    // cm:hack ISS-83 until:forge-plugin sends decision fields on an issue decision — issue decisions
    // stay prose, so the structured body is required on every other scope only
    decisionFieldsChk: check(
      'comments_decision_fields_chk',
      sql`${t.intent} <> 'decision' OR ${t.issueId} IS NOT NULL OR COALESCE(jsonb_typeof(${t.decision} -> 'decision') = 'string' AND jsonb_typeof(${t.decision} -> 'reason') = 'string' AND (${t.decision} ->> 'decision') ~ '[^[:space:]]' AND (${t.decision} ->> 'reason') ~ '[^[:space:]]', false)`,
    ),
    issueIdx: index('comments_issue_id_idx').on(t.issueId),
    issueCreatedIdx: index('comments_issue_created_idx').on(t.issueId, t.createdAt, t.id),
    requirementCreatedIdx: index('comments_requirement_created_idx')
      .on(t.requirementId, t.createdAt, t.id)
      .where(sql`requirement_id IS NOT NULL`),
    workflowCreatedIdx: index('comments_workflow_created_idx')
      .on(t.workflowId, t.createdAt, t.id)
      .where(sql`workflow_id IS NOT NULL`),
    feedbackCreatedIdx: index('comments_feedback_created_idx')
      .on(t.feedbackId, t.createdAt, t.id)
      .where(sql`feedback_id IS NOT NULL`),
    decisionCreatedIdx: index('comments_decision_created_idx')
      .on(t.createdAt, t.id)
      .where(sql`intent = 'decision'`),
    parentIdx: index('comments_parent_id_idx').on(t.parentId),
    parentFk: foreignKey({
      columns: [t.parentId],
      foreignColumns: [t.id],
      name: 'comments_parent_id_fk',
    }).onDelete('cascade'),
  }),
);

export const commentsRelations = relations(comments, ({ one, many }) => ({
  issue: one(issues, { fields: [comments.issueId], references: [issues.id] }),
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
  parent: one(comments, {
    fields: [comments.parentId],
    references: [comments.id],
    relationName: 'comment_parent',
  }),
  replies: many(comments, { relationName: 'comment_parent' }),
  attachments: many(commentAttachments),
  mentions: many(commentMentions),
}));

export const commentMentions = pgTable(
  'comment_mentions',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.commentId, t.userId] }),
    userIdx: index('comment_mentions_user_id_idx').on(t.userId),
  }),
);

export const commentMentionsRelations = relations(commentMentions, ({ one }) => ({
  comment: one(comments, { fields: [commentMentions.commentId], references: [comments.id] }),
  user: one(users, { fields: [commentMentions.userId], references: [users.id] }),
}));

export const commentAttachments = pgTable(
  'comment_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Populated when the uploader was a device principal (MCP path).
    // Null for user-principal uploads (REST multipart). Matches the
    // (user notNull, device nullable) audit shape used by `jobs`.
    uploaderDeviceId: uuid('uploader_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    commentIdx: index('comment_attachments_comment_id_idx').on(t.commentId),
    uploaderDeviceIdx: index('comment_attachments_uploader_device_id_idx').on(t.uploaderDeviceId),
  }),
);

export const commentAttachmentsRelations = relations(commentAttachments, ({ one }) => ({
  comment: one(comments, { fields: [commentAttachments.commentId], references: [comments.id] }),
  uploader: one(users, { fields: [commentAttachments.uploaderId], references: [users.id] }),
  uploaderDevice: one(devices, {
    fields: [commentAttachments.uploaderDeviceId],
    references: [devices.id],
  }),
}));

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// a comment on a requirement, design or feedback item has no issue to carry an activity row,
// so its post and every edit are a typed row here holding the content as it stood: an edited
// decision keeps what it replaced. Insert-only by comment_event_guard(), removed only with its comment
export const commentEvents = pgTable(
  'comment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: COMMENT_EVENT_KINDS }).notNull(),
    body: text('body').notNull(),
    decision: jsonb('decision').$type<DecisionFields>(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    actorAgency: text('actor_agency', { enum: ['human', 'agent'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindChk: check('comment_events_kind_chk', sql`${t.kind} IN (${inList(COMMENT_EVENT_KINDS)})`),
    agencyChk: check('comment_events_agency_chk', sql`${t.actorAgency} IN ('human', 'agent')`),
    commentIdx: index('comment_events_comment_idx').on(t.commentId, t.createdAt),
    projectIdx: index('comment_events_project_idx').on(t.projectId, t.createdAt),
  }),
);
