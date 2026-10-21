/**
 * The reads of mockups (MK-n, ISS-78): one by key, the list on one target, and the view every door
 * answers, with the baseline pin a requirement mockup has, the revision it answers and the one that
 * answers it, its comment counts, and the acts the viewer may take.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import type { MockupTargetType, MockupView } from '@forge/contracts/mockups';
import type { ActorAgency } from '@forge/contracts/permissions';
import { requirementKey } from '@forge/contracts/requirements';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { mockupComments, mockups } from '../db/schema-mockups.js';
import {
  requirementBaselinePins,
  requirementBaselines,
  requirements,
} from '../db/schema-requirements.js';
import { activeIssuePrefix, isUuid } from '../issues/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { dataPolicyOf, egressReading } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { notFound } from '../middleware/route-errors.js';
import { holds } from '../permissions/index.js';

export type MockupRow = typeof mockups.$inferSelect;

export interface MockupActor {
  userId: string;
  agency: ActorAgency;
}

export interface MockupDoor {
  providerBound?: boolean | undefined;
}

export const mockupKey = (seq: number) => `MK-${seq}`;

/** A mockup of `projectId` by uuid, `MK-n` or `n`; 404 otherwise. */
export async function rowIn(tx: Tx, projectId: string, ref: string): Promise<MockupRow> {
  const seq = /^(?:MK-)?(\d{1,9})$/i.exec(ref.trim())?.[1];
  const uuid = isUuid(ref) ? ref : null;
  if (!seq && !uuid) throw notFound(`"${ref}" is neither a mockup uuid nor a key like MK-3`);
  const [row] = await tx
    .select()
    .from(mockups)
    .where(
      and(
        eq(mockups.projectId, projectId),
        seq ? eq(mockups.mockupSeq, Number(seq)) : eq(mockups.id, uuid as string),
      ),
    );
  if (!row) throw notFound(`project ${projectId} holds no mockup ${ref}`);
  return row;
}

/** The ids of `row` and of every revision before it, newest first (REQ-49 BC-3). */
export async function chainIds(tx: Tx, row: MockupRow): Promise<string[]> {
  const ids = [row.id];
  let back = row.revisesId;
  while (back && !ids.includes(back)) {
    ids.push(back);
    const [prev] = await tx
      .select({ revisesId: mockups.revisesId })
      .from(mockups)
      .where(eq(mockups.id, back));
    back = prev?.revisesId ?? null;
  }
  return ids;
}

/** For each of `rows`: the key it revises, the key that revises it, and its comment counts. */
async function revisionFacts(rows: readonly MockupRow[]) {
  const ids = rows.map((m) => m.id);
  const back = [...new Set(rows.flatMap((m) => (m.revisesId ? [m.revisesId] : [])))];
  const [prev, next, counts] = await Promise.all([
    back.length
      ? db
          .select({ id: mockups.id, seq: mockups.mockupSeq })
          .from(mockups)
          .where(inArray(mockups.id, back))
      : [],
    db
      .select({ revisesId: mockups.revisesId, seq: mockups.mockupSeq })
      .from(mockups)
      .where(inArray(mockups.revisesId, ids)),
    db
      .select({
        mockupId: mockupComments.mockupId,
        total: sql<number>`count(*)::int`,
        open: sql<number>`(count(*) filter (where ${mockupComments.settled} is null))::int`,
      })
      .from(mockupComments)
      .where(inArray(mockupComments.mockupId, ids))
      .groupBy(mockupComments.mockupId),
  ]);
  return {
    revises: new Map(prev.map((p) => [p.id, mockupKey(p.seq)])),
    revisedBy: new Map(next.flatMap((n) => (n.revisesId ? [[n.revisesId, mockupKey(n.seq)]] : []))),
    comments: new Map(counts.map((c) => [c.mockupId, { total: c.total, open: c.open }])),
  };
}

function targetTypeOf(m: MockupRow): MockupTargetType {
  if (m.requirementId) return 'requirement';
  return m.feedbackId ? 'feedback' : 'issue';
}

/** The latest baseline of each requirement, and the mockups it pins. */
async function latestMockupPins(requirementIds: readonly string[]) {
  const out = new Map<string, { revision: number; seq: number; mockupIds: Set<string> }>();
  if (!requirementIds.length) return out;
  const baselines = await db
    .select({
      requirementId: requirementBaselines.requirementId,
      revision: requirementBaselines.revision,
      seq: requirementBaselines.seq,
    })
    .from(requirementBaselines)
    .where(inArray(requirementBaselines.requirementId, [...requirementIds]))
    .orderBy(desc(requirementBaselines.revision), desc(requirementBaselines.seq));
  for (const b of baselines) {
    if (!out.has(b.requirementId))
      out.set(b.requirementId, { revision: b.revision, seq: b.seq, mockupIds: new Set() });
  }
  const pins = await db
    .select({
      requirementId: requirementBaselinePins.requirementId,
      revision: requirementBaselinePins.revision,
      seq: requirementBaselinePins.baselineSeq,
      mockupId: requirementBaselinePins.mockupId,
    })
    .from(requirementBaselinePins)
    .where(
      and(
        inArray(requirementBaselinePins.requirementId, [...requirementIds]),
        isNotNull(requirementBaselinePins.mockupId),
      ),
    );
  for (const p of pins) {
    const latest = out.get(p.requirementId);
    if (latest && latest.revision === p.revision && latest.seq === p.seq && p.mockupId)
      latest.mockupIds.add(p.mockupId);
  }
  return out;
}

async function targetKeys(projectId: string, rows: readonly MockupRow[]) {
  const reqIds = [...new Set(rows.flatMap((m) => (m.requirementId ? [m.requirementId] : [])))];
  const fbIds = [...new Set(rows.flatMap((m) => (m.feedbackId ? [m.feedbackId] : [])))];
  const issueIds = [...new Set(rows.flatMap((m) => (m.issueId ? [m.issueId] : [])))];
  const [reqs, fbs, iss, prefix] = await Promise.all([
    reqIds.length
      ? db
          .select({ id: requirements.id, seq: requirements.reqSeq })
          .from(requirements)
          .where(inArray(requirements.id, reqIds))
      : [],
    fbIds.length
      ? db
          .select({ id: feedback.id, seq: feedback.fbSeq })
          .from(feedback)
          .where(inArray(feedback.id, fbIds))
      : [],
    issueIds.length
      ? db
          .select({ id: issues.id, seq: issues.issSeq })
          .from(issues)
          .where(inArray(issues.id, issueIds))
      : [],
    issueIds.length ? activeIssuePrefix(projectId) : null,
  ]);
  const keys = new Map<string, string>();
  for (const r of reqs) keys.set(r.id, requirementKey(r.seq));
  for (const f of fbs) keys.set(f.id, feedbackKey(f.seq));
  for (const i of iss) keys.set(i.id, formatIssueRef(prefix, i.seq));
  return keys;
}

/** The views of `rows`, all of one project, as `viewer` may see and act on them. */
export async function mockupViews(
  projectId: string,
  rows: readonly MockupRow[],
  viewer: MockupActor,
  door: MockupDoor = {},
): Promise<MockupView[]> {
  if (!rows.length) return [];
  const [keys, people, pins, access, level, facts] = await Promise.all([
    targetKeys(projectId, rows),
    peopleOf(rows.flatMap((m) => [m.proposedBy, m.decidedBy])),
    latestMockupPins(rows.flatMap((m) => (m.requirementId ? [m.requirementId] : []))),
    effectiveProjectRole(viewer.userId, projectId),
    dataPolicyOf(projectId),
    revisionFacts(rows),
  ]);
  const approver = access ? holds(access, 'mockups.approve') : false;
  const writer = access ? holds(access, 'project.write') : false;
  const fbReading = egressReading(level, { agency: viewer.agency, ...door }, 'feedback');
  return rows.map((m) => {
    const type = targetTypeOf(m);
    const targetId = m.requirementId ?? m.feedbackId ?? m.issueId ?? '';
    const key = mockupKey(m.mockupSeq);
    const pin = m.requirementId ? pins.get(m.requirementId) : undefined;
    const open = m.status === 'proposed';
    const hidden = type === 'feedback' && fbReading.withhold;
    const revisedBy = facts.revisedBy.get(m.id) ?? null;
    const discussed = (m.status === 'proposed' || m.status === 'returned') && !revisedBy;
    return {
      id: m.id,
      key,
      target: { type, key: keys.get(targetId) ?? targetId, revision: m.revision },
      kind: m.kind,
      name: hidden ? 'withheld' : m.name,
      mime: m.mime,
      size: m.size,
      caption: hidden ? null : m.caption,
      status: m.status,
      proposedBy: m.proposedBy,
      proposedByName: people.get(m.proposedBy)?.name ?? null,
      proposedAgency: m.proposedAgency,
      createdAt: m.createdAt.toISOString(),
      decidedBy: m.decidedBy,
      decidedByName: m.decidedBy ? (people.get(m.decidedBy)?.name ?? null) : null,
      decidedAt: m.decidedAt?.toISOString() ?? null,
      reason: hidden ? null : m.reason,
      pinned: pin?.mockupIds.has(m.id) ? { revision: pin.revision, seq: pin.seq } : null,
      round: m.round,
      revises: m.revisesId ? (facts.revises.get(m.revisesId) ?? null) : null,
      revisedBy,
      comments: facts.comments.get(m.id) ?? { total: 0, open: 0 },
      url: `/api/projects/${projectId}/mockups/${key}/content`,
      can: {
        accept: open && approver,
        return: open && approver,
        withdraw: open && m.proposedBy === viewer.userId,
        comment: discussed && writer && !hidden,
        revise: m.status === 'returned' && !revisedBy && writer && !hidden,
      },
    };
  });
}

export async function mockupRowsOn(
  projectId: string,
  where: { requirementId?: string; feedbackId?: string; issueId?: string },
): Promise<MockupRow[]> {
  const on = where.requirementId
    ? eq(mockups.requirementId, where.requirementId)
    : where.feedbackId
      ? eq(mockups.feedbackId, where.feedbackId)
      : eq(mockups.issueId, where.issueId ?? '');
  return db
    .select()
    .from(mockups)
    .where(and(eq(mockups.projectId, projectId), on))
    .orderBy(asc(mockups.mockupSeq));
}

/** The proposed mockups of `projectId` the viewer may accept, oldest first, for the approval inbox. */
export async function waitingMockupsAs(
  projectId: string,
  viewer: MockupActor,
): Promise<MockupView[]> {
  const rows = await db
    .select()
    .from(mockups)
    .where(and(eq(mockups.projectId, projectId), eq(mockups.status, 'proposed')))
    .orderBy(asc(mockups.createdAt));
  return (await mockupViews(projectId, rows, viewer)).filter((m) => m.can.accept);
}
