/**
 * The writes of mockups (MK-n, ISS-78, REQ-49): a person or an agent proposes one about a
 * requirement revision, a feedback item or an issue, or proposes a returned one again as its next
 * revision, settling the comments it names; a holder of mockups.approve accepts it or returns it
 * with a reason, and its author may withdraw it while it waits. Each write runs in one transaction
 * under the project's mockup lock and returns its refusals; the bytes reach the one store before the
 * row is written.
 */

import { randomUUID } from 'node:crypto';
import { MOCKUP_MACHINE } from '@forge/contracts/mockup-machine';
import type { MockupView, ProposeMockupRequest } from '@forge/contracts/mockups';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { mockupComments, mockups } from '../db/schema-mockups.js';
import { getStorage } from '../integrations/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { actorFor, permissionFactsOf, projectResource, requireCan } from '../permissions/index.js';
import { mockupContent } from './content.js';
import {
  chainIds,
  type MockupActor,
  type MockupRow,
  mockupKey,
  mockupViews,
  rowIn,
} from './read.js';
import {
  decidedRefusal,
  deciderRefusal,
  type MockupRefusal,
  queueRefusal,
  returnReasonRefusal,
  revisesRefusal,
  settleRefusals,
  settlesWithoutRevisesRefusal,
  withdrawRefusal,
} from './rules.js';
import { proposalTarget, revisedRow, type Target } from './target.js';

export type MockupOutcome =
  | { ok: true; mockup: MockupView; created?: boolean }
  | { ok: false; refusals: MockupRefusal[] };

export async function lockMockups(tx: Tx, projectId: string): Promise<void> {
  await lockXact(tx, 'mockups', projectId);
}

async function answer(
  projectId: string,
  id: string,
  viewer: MockupActor,
  created = false,
): Promise<MockupOutcome> {
  const row = await rowIn(db, projectId, id);
  const [mockup] = await mockupViews(projectId, [row], viewer);
  if (!mockup) throw new Error('mockups: the view of a written row is missing');
  return { ok: true, mockup, ...(created ? { created } : {}) };
}

const openOn = (t: Target) =>
  and(
    eq(mockups.status, 'proposed'),
    t.requirementId
      ? eq(mockups.requirementId, t.requirementId)
      : t.feedbackId
        ? eq(mockups.feedbackId, t.feedbackId)
        : eq(mockups.issueId, t.issueId ?? ''),
  );

/** The refusals a next revision meets at its write, read under the lock: the mockup it revises and the comments it settles. */
async function revisionRefusals(
  tx: Tx,
  revised: MockupRow,
  body: ProposeMockupRequest,
): Promise<MockupRefusal[]> {
  const key = mockupKey(revised.mockupSeq);
  const now = await rowIn(tx, revised.projectId, revised.id);
  const [next] = await tx
    .select({ seq: mockups.mockupSeq })
    .from(mockups)
    .where(eq(mockups.revisesId, revised.id));
  const refused = revisesRefusal(key, now.status, next ? mockupKey(next.seq) : null);
  if (refused) return [refused];
  const named = [...(body.answers ?? []), ...(body.resolves ?? [])];
  if (!named.length) return [];
  const comments = await tx
    .select({ id: mockupComments.id, settled: mockupComments.settled })
    .from(mockupComments)
    .where(inArray(mockupComments.mockupId, await chainIds(tx, revised)));
  return settleRefusals(
    key,
    new Map(comments.map((c) => [c.id, c])),
    (body.answers ?? []).map((a) => a.comment),
    (body.resolves ?? []).map((r) => r.comment),
  );
}

/** What the new revision settles: each comment it answers or resolves, once, naming it. */
async function settleComments(tx: Tx, by: string, body: ProposeMockupRequest) {
  const at = new Date();
  const settle = (comment: string, as: 'answered' | 'resolved', note: string | null) =>
    tx
      .update(mockupComments)
      .set({ settled: as, settledByMockupId: by, settledNote: note, settledAt: at })
      .where(and(eq(mockupComments.id, comment), isNull(mockupComments.settled)));
  for (const a of body.answers ?? []) await settle(a.comment, 'answered', a.note ?? null);
  for (const r of body.resolves ?? []) await settle(r.comment, 'resolved', r.note);
}

/**
 * A person or an agent proposes a mockup about one target, or a returned one again as its next
 * revision (`revises`), which answers or resolves the comments it names (REQ-49 BC-2, BC-3).
 */
export async function proposeMockup(input: {
  projectId: string;
  actor: MockupActor;
  body: ProposeMockupRequest;
}): Promise<MockupOutcome> {
  const { projectId, actor, body } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const loose = settlesWithoutRevisesRefusal(body);
  if (loose) return { ok: false, refusals: [loose] };
  const revised = body.revises ? await revisedRow(projectId, body.revises) : null;
  if (revised && 'code' in revised) return { ok: false, refusals: [revised] };
  const target = await proposalTarget(projectId, body, actor.userId, revised);
  if ('code' in target) return { ok: false, refusals: [target] };
  const got = await mockupContent(projectId, await dataPolicyOf(projectId), body);
  if (!got.ok) return { ok: false, refusals: got.refusals };
  const { content } = got;
  const stored = await getStorage().put(
    `mockups/${projectId}/${randomUUID()}-${content.name}`,
    content.bytes,
    content.mime,
  );
  let id = '';
  const refusals = await db.transaction(async (tx) => {
    await lockMockups(tx, projectId);
    if (revised) {
      const refused = await revisionRefusals(tx, revised, body);
      if (refused.length) return refused;
    }
    const [{ open } = { open: 0 }] = await tx
      .select({ open: sql<number>`count(*)::int` })
      .from(mockups)
      .where(and(eq(mockups.projectId, projectId), openOn(target)));
    const full = queueRefusal(target.label, open);
    if (full) return [full];
    const [{ next } = { next: 1 }] = await tx
      .select({ next: sql<number>`coalesce(max(${mockups.mockupSeq}), 0)::int + 1` })
      .from(mockups)
      .where(eq(mockups.projectId, projectId));
    const [row] = await tx
      .insert(mockups)
      .values({
        projectId,
        mockupSeq: next,
        requirementId: target.requirementId,
        revision: target.revision,
        feedbackId: target.feedbackId,
        issueId: target.issueId,
        kind: content.kind,
        name: content.name,
        mime: content.mime,
        size: content.bytes.length,
        caption: content.caption,
        storagePath: stored.path,
        proposedBy: actor.userId,
        proposedAgency: actor.agency,
        revisesId: revised?.id ?? null,
        round: revised ? revised.round + 1 : 1,
      })
      .returning({ id: mockups.id });
    id = row?.id ?? '';
    if (revised) await settleComments(tx, id, body);
    return null;
  });
  if (refusals) {
    await getStorage()
      .delete(stored.path)
      .catch((err: unknown) =>
        logger.error({ err, path: stored.path }, 'mockups: a refused proposal was not removed'),
      );
    return { ok: false, refusals };
  }
  return answer(projectId, id, actor, true);
}

async function decide(
  projectId: string,
  ref: string,
  actor: MockupActor,
  check: (row: MockupRow, key: string) => Promise<MockupRefusal | null>,
  set: { status: 'accepted' | 'returned' | 'withdrawn'; reason: string | null },
): Promise<MockupOutcome> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const first = await rowIn(db, projectId, ref);
  const refusals = await db.transaction(async (tx) => {
    await lockMockups(tx, projectId);
    const row = await rowIn(tx, projectId, first.id);
    const key = mockupKey(row.mockupSeq);
    const refused = decidedRefusal(key, row.status) ?? (await check(row, key));
    if (refused) return [refused];
    const moved = await transition(tx, MOCKUP_MACHINE, {
      to: set.status,
      expect: row.status,
      set: { reason: set.reason, decidedBy: actor.userId, decidedAt: new Date() },
      where: eq(mockups.id, row.id),
      reason: set.reason,
      actor: { type: 'user', id: actor.userId, agency: actor.agency },
      source: 'mockups',
      returning: ['id'],
    });
    movedRow(moved);
    return null;
  });
  if (refusals) return { ok: false, refusals };
  return answer(projectId, first.id, actor);
}

async function deciderFor(
  actor: MockupActor,
  projectId: string,
  key: string,
  act: 'accept' | 'return',
) {
  return deciderRefusal(await permissionFactsOf(actor.userId, projectId), key, act);
}

/** A holder of mockups.approve accepts a proposed mockup, its author included; an accepted requirement mockup is pinned by the next agree or re-pin. */
export function acceptMockup(input: {
  projectId: string;
  ref: string;
  actor: MockupActor;
  reason?: string | undefined;
}): Promise<MockupOutcome> {
  return decide(
    input.projectId,
    input.ref,
    input.actor,
    (_row, key) => deciderFor(input.actor, input.projectId, key, 'accept'),
    { status: 'accepted', reason: input.reason?.trim() || null },
  );
}

/** A holder of mockups.approve returns a proposed mockup, saying why. */
export async function returnMockup(input: {
  projectId: string;
  ref: string;
  actor: MockupActor;
  reason?: string | undefined;
}): Promise<MockupOutcome> {
  const why = returnReasonRefusal(input.reason);
  if (why) return { ok: false, refusals: [why] };
  return decide(
    input.projectId,
    input.ref,
    input.actor,
    (_row, key) => deciderFor(input.actor, input.projectId, key, 'return'),
    { status: 'returned', reason: input.reason?.trim() ?? null },
  );
}

/** Its author takes a waiting mockup back. */
export function withdrawMockup(input: {
  projectId: string;
  ref: string;
  actor: MockupActor;
}): Promise<MockupOutcome> {
  return decide(
    input.projectId,
    input.ref,
    input.actor,
    async (row, key) => withdrawRefusal(key, input.actor.userId, row.proposedBy),
    { status: 'withdrawn', reason: null },
  );
}

/** The mockups drawn on a feedback, removed with what the reporter gave (UC15); answers their bytes' paths. */
export async function deleteFeedbackMockups(tx: Tx, feedbackId: string): Promise<string[]> {
  const gone = await tx
    .delete(mockups)
    .where(eq(mockups.feedbackId, feedbackId))
    .returning({ path: mockups.storagePath });
  return gone.map((g) => g.path);
}
