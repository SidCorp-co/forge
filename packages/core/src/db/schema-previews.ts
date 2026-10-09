import type { LaneDecision } from '@forge/contracts/fast-lane';
import { PREVIEW_FAILURE_REASONS, PREVIEW_STATES } from '@forge/contracts/preview';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentSessions } from './schema-agent-sessions.js';
import { users } from './schema-auth.js';
import { devices } from './schema-devices.js';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// A run's dev server served to the project's members from a Forge link (REQ-39,
// docs/proposals/live-preview.md). `state` is PREVIEW_MACHINE's, written only by the kernel
// transition (0477 guards it); `slug` is the host label under PREVIEW_DOMAIN. One open preview per
// session: a run holds one preview at a time.
export const previews = pgTable(
  'previews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    state: text('state', { enum: PREVIEW_STATES }).notNull().default('starting'),
    reason: text('reason', { enum: PREVIEW_FAILURE_REASONS }),
    detail: text('detail'),
    command: text('command').notNull(),
    port: integer('port'),
    idleMinutes: integer('idle_minutes').notNull(),
    approvedPatchId: text('approved_patch_id'),
    approvedFiles: jsonb('approved_files').$type<string[]>(),
    laneDecision: jsonb('lane_decision').$type<LaneDecision>(),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    liveAt: timestamp('live_at', { withTimezone: true }),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    slugUq: uniqueIndex('previews_slug_uq').on(t.slug),
    oneOpenPerSessionUq: uniqueIndex('previews_one_open_per_session_uq')
      .on(t.sessionId)
      .where(sql`state IN ('starting', 'live', 'idle_closed')`),
    issueIdx: index('previews_issue_idx').on(t.issueId, t.createdAt),
    deviceIdx: index('previews_device_idx').on(t.deviceId),
    stateChk: check('previews_state_chk', sql`${t.state} IN (${inList(PREVIEW_STATES)})`),
    reasonChk: check(
      'previews_reason_chk',
      sql`${t.reason} IS NULL OR ${t.reason} IN (${inList(PREVIEW_FAILURE_REASONS)})`,
    ),
    failedReasonChk: check(
      'previews_failed_reason_chk',
      sql`(${t.state} = 'failed') = (${t.reason} IS NOT NULL)`,
    ),
    slugChk: check('previews_slug_chk', sql`${t.slug} ~ '^p-[a-z2-7]{16}$'`),
    portChk: check('previews_port_chk', sql`${t.port} IS NULL OR ${t.port} BETWEEN 1024 AND 65535`),
    idleChk: check('previews_idle_chk', sql`${t.idleMinutes} BETWEEN 5 AND 240`),
    patchChk: check(
      'previews_patch_chk',
      sql`${t.approvedPatchId} IS NULL OR ${t.approvedPatchId} ~ '^[0-9a-f]{40}$'`,
    ),
    approvedChk: check(
      'previews_approved_chk',
      sql`(${t.state} = 'approved') = (${t.approvedPatchId} IS NOT NULL)`,
    ),
  }),
);

export type PreviewRow = typeof previews.$inferSelect;
