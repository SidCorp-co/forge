/**
 * Comments on a mockup (REQ-49 BC-2): a person, or an agent, says what to change and may pin it to a
 * point or a region of the frame, as fractions of its width and height. A comment is written while
 * the mockup is still discussed (proposed, or returned with no next revision) and its next revision
 * settles it, answered or resolved (`service.ts:proposeMockup`). The read is the whole chain, so a
 * revision shows what it answers.
 */

import type {
  CommentMockupRequest,
  MockupCommentsResponse,
  MockupCommentView,
} from '@forge/contracts/mockups';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { mockupComments, mockups } from '../db/schema-mockups.js';
import { dataPolicyOf, egressReading } from '../lib/data-egress.js';
import { peopleOf } from '../lib/people.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import {
  chainIds,
  type MockupActor,
  type MockupDoor,
  type MockupRow,
  mockupKey,
  rowIn,
} from './read.js';
import { commentClosedRefusal, commentsFullRefusal, type MockupRefusal } from './rules.js';
import { lockMockups } from './service.js';

type CommentRow = typeof mockupComments.$inferSelect;

export type CommentOutcome =
  | { ok: true; comment: MockupCommentView }
  | { ok: false; refusals: MockupRefusal[] };

function pinOf(c: CommentRow): MockupCommentView['pin'] {
  if (c.pinX === null || c.pinY === null) return null;
  return {
    x: c.pinX,
    y: c.pinY,
    ...(c.pinW !== null && c.pinH !== null ? { w: c.pinW, h: c.pinH } : {}),
  };
}

async function commentViews(
  rows: readonly CommentRow[],
  withheld: boolean,
): Promise<MockupCommentView[]> {
  const mockupIds = [
    ...new Set(
      rows.flatMap((c) => [c.mockupId, ...(c.settledByMockupId ? [c.settledByMockupId] : [])]),
    ),
  ];
  const [people, seqs] = await Promise.all([
    peopleOf(rows.map((c) => c.authorId)),
    mockupIds.length
      ? db
          .select({ id: mockups.id, seq: mockups.mockupSeq })
          .from(mockups)
          .where(inArray(mockups.id, mockupIds))
      : [],
  ]);
  const keyOf = new Map(seqs.map((m) => [m.id, mockupKey(m.seq)]));
  return rows.map((c) => ({
    id: c.id,
    on: keyOf.get(c.mockupId) ?? c.mockupId,
    body: withheld ? 'withheld' : c.body,
    pin: pinOf(c),
    authorId: c.authorId,
    authorName: people.get(c.authorId)?.name ?? null,
    authorAgency: c.authorAgency,
    createdAt: c.createdAt.toISOString(),
    settled:
      c.settled && c.settledByMockupId && c.settledAt
        ? {
            as: c.settled,
            by: keyOf.get(c.settledByMockupId) ?? c.settledByMockupId,
            note: withheld ? null : c.settledNote,
            at: c.settledAt.toISOString(),
          }
        : null,
  }));
}

// a comment on a feedback item's mockup is that reporter's data, withheld as its name is from an
// agent reading a no_egress project (read.ts:mockupViews)
async function withheldFor(
  projectId: string,
  row: MockupRow,
  viewer: MockupActor,
  door: MockupDoor,
): Promise<boolean> {
  if (!row.feedbackId) return false;
  const level = await dataPolicyOf(projectId);
  return egressReading(level, { agency: viewer.agency, ...door }, 'feedback').withhold;
}

/** Every comment on the mockup `ref` names and on the revisions before it, oldest first. */
export async function mockupCommentsAs(
  viewer: MockupActor,
  projectId: string,
  ref: string,
  door: MockupDoor = {},
): Promise<MockupCommentsResponse> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const row = await rowIn(db, projectId, ref);
  const rows = await db
    .select()
    .from(mockupComments)
    .where(inArray(mockupComments.mockupId, await chainIds(db, row)))
    .orderBy(asc(mockupComments.createdAt), asc(mockupComments.id));
  const comments = await commentViews(rows, await withheldFor(projectId, row, viewer, door));
  return { comments, open: comments.filter((c) => !c.settled).length };
}

/** A person or an agent comments on a mockup still under discussion, optionally pinned to its frame. */
export async function commentOnMockup(input: {
  projectId: string;
  ref: string;
  actor: MockupActor;
  body: CommentMockupRequest;
}): Promise<CommentOutcome> {
  const { projectId, actor, body } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const first = await rowIn(db, projectId, input.ref);
  const written = await db.transaction(async (tx) => {
    await lockMockups(tx, projectId);
    const row = await rowIn(tx, projectId, first.id);
    const key = mockupKey(row.mockupSeq);
    const [[next], [{ count } = { count: 0 }]] = await Promise.all([
      tx.select({ seq: mockups.mockupSeq }).from(mockups).where(eq(mockups.revisesId, row.id)),
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(mockupComments)
        .where(eq(mockupComments.mockupId, row.id)),
    ]);
    const refused =
      commentClosedRefusal(key, row.status, next ? mockupKey(next.seq) : null) ??
      commentsFullRefusal(key, count);
    if (refused) return refused;
    const [c] = await tx
      .insert(mockupComments)
      .values({
        projectId,
        mockupId: row.id,
        authorId: actor.userId,
        authorAgency: actor.agency,
        body: body.body,
        pinX: body.pin?.x ?? null,
        pinY: body.pin?.y ?? null,
        pinW: body.pin?.w ?? null,
        pinH: body.pin?.h ?? null,
      })
      .returning();
    if (!c) throw new Error('mockups: a written comment returned no row');
    return c;
  });
  if ('code' in written) return { ok: false, refusals: [written] };
  const [comment] = await commentViews([written], false);
  if (!comment) throw new Error('mockups: the view of a written comment is missing');
  return { ok: true, comment };
}
