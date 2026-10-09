/**
 * The writes of mockups (MK-n, ISS-78): a person or an agent proposes one about a feedback item or
 * an issue, a holder of mockups.approve accepts it or returns it with a reason, and its author
 * may withdraw it while it waits. Each write runs in one transaction under the project's mockup
 * lock and returns its refusals; the bytes reach the one store before the row is written.
 */

import { randomUUID } from 'node:crypto';
import { MOCKUP_MACHINE } from '@forge/contracts/mockup-machine';
import type { MockupTargetInput, MockupView, ProposeMockupRequest } from '@forge/contracts/mockups';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { mockups } from '../db/schema-mockups.js';
import { requirements } from '../db/schema-requirements.js';
import { feedbackRefIn, issueRefIn, requirementRefIn } from '../feedback/index.js';
import { getStorage } from '../integrations/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { actorFor, permissionFactsOf, projectResource, requireCan } from '../permissions/index.js';
import { mockupContent } from './content.js';
import { type MockupActor, type MockupRow, mockupKey, mockupViews, rowIn } from './read.js';
import {
  decidedRefusal,
  deciderRefusal,
  type MockupRefusal,
  queueRefusal,
  requirementTargetRefusal,
  returnReasonRefusal,
  withdrawRefusal,
} from './rules.js';

export type MockupOutcome =
  | { ok: true; mockup: MockupView; created?: boolean }
  | { ok: false; refusals: MockupRefusal[] };

async function lockMockups(tx: Tx, projectId: string): Promise<void> {
  await lockXact(tx, 'mockups', projectId);
}

interface Target {
  feedbackId: string | null;
  issueId: string | null;
  label: string;
}

const invalidTarget = (path: string, detail: string): MockupRefusal => ({
  code: 'MOCKUP_TARGET_INVALID',
  path,
  detail,
});

/** The one target a proposal names, inside `projectId`, or the refusal naming why it is not one. */
async function resolveMockupTarget(
  projectId: string,
  target: MockupTargetInput,
  userId: string,
): Promise<Target | MockupRefusal> {
  const none = { feedbackId: null, issueId: null };
  if ('issue' in target) {
    const issue = await issueRefIn(projectId, target.issue, userId, '/target/issue');
    if ('code' in issue) return invalidTarget(issue.path, issue.detail);
    return { ...none, issueId: issue.id, label: issue.key };
  }
  if ('feedback' in target) {
    const item = await feedbackRefIn(projectId, target.feedback, '/target/feedback');
    if ('code' in item) return invalidTarget(item.path, item.detail);
    return { ...none, feedbackId: item.id, label: item.key };
  }
  const req = await requirementRefIn(projectId, target.requirement, '/target/requirement');
  if ('code' in req) return invalidTarget(req.path, req.detail);
  return requirementTargetRefusal(projectId, req.key, 'propose', target.revision);
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
    t.feedbackId ? eq(mockups.feedbackId, t.feedbackId) : eq(mockups.issueId, t.issueId ?? ''),
  );

/** A person or an agent proposes a mockup about one target. */
export async function proposeMockup(input: {
  projectId: string;
  actor: MockupActor;
  body: ProposeMockupRequest;
}): Promise<MockupOutcome> {
  const { projectId, actor, body } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const target = await resolveMockupTarget(projectId, body.target, actor.userId);
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
      })
      .returning({ id: mockups.id });
    id = row?.id ?? '';
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

async function requirementKeyOf(requirementId: string): Promise<string> {
  const [req] = await db
    .select({ seq: requirements.reqSeq })
    .from(requirements)
    .where(eq(requirements.id, requirementId));
  return req ? requirementKey(req.seq) : requirementId;
}

/** A holder of mockups.approve accepts a proposed mockup about a feedback item or an issue, its author included. */
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
    async (row, key) =>
      row.requirementId !== null && row.revision !== null
        ? requirementTargetRefusal(
            input.projectId,
            await requirementKeyOf(row.requirementId),
            'accept',
            row.revision,
          )
        : deciderFor(input.actor, input.projectId, key, 'accept'),
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
