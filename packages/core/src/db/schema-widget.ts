import {
  WIDGET_DRAFT_KINDS,
  WIDGET_DRAFT_STATES,
  WIDGET_IDENTITY_MODES,
} from '@forge/contracts/widget';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { conversations } from './schema-conversations.js';
import { feedback } from './schema-feedback.js';
import { integrationBindings } from './schema-project-config.js';
import { projects } from './schema-projects.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * The account a widget binding files Feedback as: one agent-kind user per binding, owned by the
 * `widget` domain. It is a member of no project and no organisation, so it holds no permission
 * anywhere and reads nothing; it exists because a Feedback row names its reporter by user.
 */
export const widgetPrincipals = pgTable(
  'widget_principals',
  {
    bindingId: uuid('binding_id')
      .primaryKey()
      .references(() => integrationBindings.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userUq: uniqueIndex('widget_principals_user_uq').on(t.userId),
  }),
);

/**
 * One visitor session of a widget binding, owned by the `widget` domain: the SHA-256 of the token
 * the frame holds (the token is shown once), the conversation it talks in, who the visitor said
 * they are under the binding's identity mode, the page they were on, and the turns they spent.
 */
export const widgetSessions = pgTable(
  'widget_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => integrationBindings.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    visitorId: uuid('visitor_id').notNull(),
    identityMode: text('identity_mode', { enum: WIDGET_IDENTITY_MODES }).notNull(),
    visitorEmail: text('visitor_email'),
    visitorName: text('visitor_name'),
    /** The client's own id for its user, as its backend signed it; set in `signed` mode only. */
    signedUserId: text('signed_user_id'),
    /** The page the visitor was last on, as the host page reported it: data, never instructions. */
    pageContext: jsonb('page_context'),
    /**
     * The origin of the page that framed the widget, as the frame read it (ancestorOrigins or the
     * referrer): one of the binding's allowed origins, or null where the frame could not tell.
     */
    embeddedAt: text('embedded_at'),
    /** The visitor messages this session's conversation took, against the binding's per-conversation cap. */
    turns: integer('turns').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    tokenHashUq: uniqueIndex('widget_sessions_token_hash_uq').on(t.tokenHash),
    conversationUq: uniqueIndex('widget_sessions_conversation_uq').on(t.conversationId),
    visitorIdx: index('widget_sessions_binding_visitor_idx').on(t.bindingId, t.visitorId),
    tokenHashChk: check('widget_sessions_token_hash_chk', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    identityModeChk: check(
      'widget_sessions_identity_mode_chk',
      sql`${t.identityMode} IN (${inList(WIDGET_IDENTITY_MODES)})`,
    ),
    identityChk: check(
      'widget_sessions_identity_chk',
      sql`(${t.identityMode} <> 'email' OR ${t.visitorEmail} IS NOT NULL) AND (${t.identityMode} = 'signed') = (${t.signedUserId} IS NOT NULL)`,
    ),
    pageContextChk: check(
      'widget_sessions_page_context_chk',
      sql`${t.pageContext} IS NULL OR jsonb_typeof(${t.pageContext}) = 'object'`,
    ),
    turnsChk: check('widget_sessions_turns_chk', sql`${t.turns} >= 0`),
    expiryChk: check('widget_sessions_expiry_chk', sql`${t.expiresAt} > ${t.createdAt}`),
  }),
);

/**
 * A Feedback item the widget's assistant proposed to a visitor, owned by the `widget` domain. Only
 * the visitor's own session files it (`filed`, naming the Feedback) or discards it; a pending draft
 * the assistant replaces is discarded.
 */
export const widgetDrafts = pgTable(
  'widget_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => widgetSessions.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: WIDGET_DRAFT_KINDS }).notNull(),
    title: text('title').notNull(),
    did: text('did'),
    saw: text('saw').notNull(),
    expected: text('expected'),
    whereSeen: text('where_seen'),
    state: text('state', { enum: WIDGET_DRAFT_STATES }).notNull().default('pending'),
    /** The Feedback the visitor's confirm filed; null on every other state, and after that item is purged. */
    feedbackId: uuid('feedback_id').references(() => feedback.id, { onDelete: 'set null' }),
    /** The filed item's key (FB-n), for the frame to show it again after a reload. */
    feedbackKey: text('feedback_key'),
    /**
     * The status link's token, sealed in the integration vault, so a reloaded frame can show the
     * link again; the item's own record keeps only its SHA-256, which is what a status read looks up.
     */
    statusTokenEnc: bytea('status_token_enc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => ({
    sessionIdx: index('widget_drafts_session_idx').on(t.sessionId, t.createdAt),
    kindChk: check('widget_drafts_kind_chk', sql`${t.kind} IN (${inList(WIDGET_DRAFT_KINDS)})`),
    stateChk: check('widget_drafts_state_chk', sql`${t.state} IN (${inList(WIDGET_DRAFT_STATES)})`),
    decidedChk: check(
      'widget_drafts_decided_chk',
      sql`(${t.state} = 'pending') = (${t.decidedAt} IS NULL)`,
    ),
    feedbackChk: check(
      'widget_drafts_feedback_chk',
      sql`${t.feedbackId} IS NULL OR ${t.state} = 'filed'`,
    ),
    filedChk: check(
      'widget_drafts_filed_chk',
      sql`(${t.state} = 'filed') = (${t.feedbackKey} IS NOT NULL AND ${t.statusTokenEnc} IS NOT NULL)`,
    ),
  }),
);
