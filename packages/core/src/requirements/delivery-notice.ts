/**
 * The requirement.delivered notice (workflow requirement-lifecycle edge in_delivery → delivered):
 * the phase is a view, so the outbox only says when a read found it reading delivered. A notice that
 * arrives late is late; the phase read on every query is still right.
 *
 * Two readers raise it, once per requirement revision: a linked issue's move to a terminal status,
 * and the `requirement-delivery-sweep` timer, which re-reads every agreed requirement whose live
 * issues all closed and whose revision was not raised. The sweep is the one that tells a delivery
 * the close could not read: production unreadable then, so coverage counted nothing and the phase
 * read in_delivery (ISS-489 r3), or a verdict that arrived after the last close.
 *
 * "Raised" is the outbox's own record of the event for that revision, taken under an advisory lock
 * so the two readers cannot both raise it. Past the outbox's retention a requirement still not
 * accepted may be raised again; the notification's dedupe key (`notify-requirements.ts`) keeps the
 * person's notice to one.
 */

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { requirementKey } from '@forge/contracts/requirements';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { issues } from '../db/schema.js';
import { type RequirementStatus, requirements } from '../db/schema-requirements.js';
import { logger } from '../lib/logger.js';
import { consume, emitEvent } from '../outbox/index.js';
import { deliveryIn, liveBuildOfRequirement } from './acceptance.js';

interface NoticeRow {
  id: string;
  projectId: string;
  reqSeq: number;
  title: string;
  status: RequirementStatus;
  currentRevision: number | null;
}

const NOTICE_COLUMNS = {
  id: requirements.id,
  projectId: requirements.projectId,
  reqSeq: requirements.reqSeq,
  title: requirements.title,
  status: requirements.status,
  currentRevision: requirements.currentRevision,
};

async function raised(ex: Pick<Tx, 'execute'>, id: string, revision: number): Promise<boolean> {
  const found = rowsOf<{ one: number }>(
    await ex.execute(sql`
      SELECT 1 AS one FROM pipeline_outbox
       WHERE type = 'requirement.delivered'
         AND payload ->> 'requirementId' = ${id}
         AND payload ->> 'revision' = ${String(revision)}
       LIMIT 1`),
  );
  return found.length > 0;
}

/** Raise the notice for `row`'s current revision where it reads delivered and was not raised yet. */
async function raiseIfDelivered(row: NoticeRow): Promise<boolean> {
  if (row.status !== 'agreed' || row.currentRevision === null) return false;
  const revision = row.currentRevision;
  if (await raised(db, row.id, revision)) return false;
  const liveBuild = await liveBuildOfRequirement(row.projectId, row.id);
  const { delivery } = await deliveryIn(db, row.projectId, row, liveBuild);
  if (delivery.phase !== 'delivered') return false;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`requirement-delivered:${row.id}@r${revision}`}))`,
    );
    if (await raised(tx, row.id, revision)) return false;
    await emitEvent(tx, 'requirement.delivered', {
      projectId: row.projectId,
      requirementId: row.id,
      key: requirementKey(row.reqSeq),
      title: row.title,
      revision,
    });
    return true;
  });
}

async function noticeDelivered(issueId: string): Promise<void> {
  const [row] = await db
    .select(NOTICE_COLUMNS)
    .from(issues)
    .innerJoin(requirements, eq(requirements.id, issues.requirementId))
    .where(eq(issues.id, issueId));
  if (row) await raiseIfDelivered(row);
}

/**
 * Every agreed requirement whose live linked issues have all closed and whose current revision was
 * not raised: the only ones a read could newly find delivered.
 */
async function unraisedCandidates(): Promise<NoticeRow[]> {
  return rowsOf<NoticeRow>(
    await db.execute(sql`
      SELECT r.id, r.project_id AS "projectId", r.req_seq AS "reqSeq", r.title, r.status,
             r.current_revision AS "currentRevision"
        FROM requirements r
       WHERE r.status = 'agreed'
         AND r.current_revision IS NOT NULL
         AND EXISTS (SELECT 1 FROM issues i WHERE i.requirement_id = r.id AND i.status <> 'dropped')
         AND NOT EXISTS (
               SELECT 1 FROM issues i
                WHERE i.requirement_id = r.id AND i.status NOT IN ('closed', 'dropped'))
         AND NOT EXISTS (
               SELECT 1 FROM pipeline_outbox o
                WHERE o.type = 'requirement.delivered'
                  AND o.payload ->> 'requirementId' = r.id::text
                  AND o.payload ->> 'revision' = r.current_revision::text)
       ORDER BY r.project_id, r.req_seq`),
  );
}

/**
 * The sweep: raise the notice for each candidate a read now finds delivered. One requirement that
 * cannot be read is logged and the rest are still read; it is read again on the next tick.
 */
export async function sweepDeliveredRequirements(): Promise<{ read: number; raised: number }> {
  const out = { read: 0, raised: 0 };
  for (const row of await unraisedCandidates()) {
    out.read += 1;
    try {
      if (await raiseIfDelivered(row)) out.raised += 1;
    } catch (err) {
      logger.warn(
        { err, requirementId: row.id, projectId: row.projectId },
        'requirement-delivery-sweep: the delivery could not be read; it is read again next tick',
      );
    }
  }
  return out;
}

export function registerRequirementDelivery(): void {
  consume('issue.transitioned', {
    name: 'requirement-delivery',
    handle: async (p) => {
      // A linked issue closed or dropped can be the move that completes the delivery.
      if (!(ISSUE_TERMINAL_STATUSES as readonly string[]).includes(p.to)) return;
      await noticeDelivered(p.id);
    },
  });
}
