/**
 * A settled POC room written into the requirement record (REQ-44 BC-7, BC-8), through the doors every
 * revision, picture and issue takes: the settled items become criteria of a new revision of the item's
 * requirement (a new screen requirement where the room was about a feedback item), the page kept at
 * settle is that revision's picture, and a follow-up issue linked to the requirement verifies, reviews
 * and cleans the merge that already landed. Only the settled items are written.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementRevisions } from '../db/schema-requirements.js';
import { createIssue } from '../issues/index.js';
import type { RoomSettleWriter } from '../previews/index.js';
import { linkIssue } from './issue-links.js';
import { liveCriteriaOf } from './kept-preview.js';
import { writePicture } from './picture.js';
import { rowIn } from './read.js';
import { openRevisionOf } from './revision-write.js';
import { createRequirement, writeRevision } from './service.js';

type Refusal = { code: string; detail: string };

const firstOf = (refusals: readonly { code: string; detail: string }[], fallback: string) =>
  refusals.length > 0
    ? refusals.map((r) => ({ code: r.code, detail: r.detail }))
    : [{ code: fallback, detail: fallback }];

async function headKindOf(requirementId: string, head: number | null): Promise<string | null> {
  if (head === null) return null;
  const [row] = await db
    .select({ kind: requirementRevisions.kind })
    .from(requirementRevisions)
    .where(
      and(
        eq(requirementRevisions.requirementId, requirementId),
        eq(requirementRevisions.revision, head),
      ),
    );
  return row?.kind ?? null;
}

async function latestRevisionOf(requirementId: string): Promise<number | null> {
  const [row] = await db
    .select({ revision: requirementRevisions.revision })
    .from(requirementRevisions)
    .where(eq(requirementRevisions.requirementId, requirementId))
    .orderBy(desc(requirementRevisions.revision))
    .limit(1);
  return row?.revision ?? null;
}

const refusal: RoomSettleWriter['refusal'] = async ({ projectId, about }) => {
  if (about.kind === 'feedback') return null;
  const row = await rowIn(db, projectId, about.key);
  const kind = await headKindOf(row.id, row.currentRevision);
  if (kind !== null && kind !== 'screen') {
    return {
      code: 'ROOM_NOT_A_SCREEN',
      detail: `${about.key} is a ${kind} requirement, and a room's picture is the page it showed, which only a screen draws: correct ${about.key}'s kind to screen, or open the room about a screen requirement`,
    };
  }
  const open = await openRevisionOf(db, row.id);
  if (open) {
    return {
      code: 'REQUIREMENT_REVISION_OPEN',
      detail: `${about.key} has revision ${open.revision} ${open.state}, and a requirement has one open revision at a time: have it accepted, returned or withdrawn, then settle; nothing was merged`,
    };
  }
  return null;
};

/** What the follow-up issue's plan says: the merge it follows, and the after-the-fact work it owes. */
export function followUpBody(input: {
  requirement: string;
  merge: { into: string; sha: string; branch: string; roomId: string };
  items: readonly { text: string; commit: string }[];
}): string {
  const { merge } = input;
  return [
    `POC room ${merge.roomId} merged ${merge.branch} straight into ${merge.into} as merge commit ${merge.sha}, with no gate in front of it (REQ-44 BC-8). This issue is the gates, after the fact.`,
    '',
    `Settled items (${input.requirement}), each with the commit that showed it:`,
    ...input.items.map((i) => `- ${i.text} (${i.commit.slice(0, 12)})`),
    '',
    `1. Read the POC diff: git diff ${merge.sha}^1 ${merge.sha}.`,
    '2. Verify: run the project gate over it and make every settled item hold as a test.',
    '3. Review it as any change is reviewed.',
    "4. Bring it to the project's code standards; remove anything no settled item needs.",
  ].join('\n');
}

const write: RoomSettleWriter['write'] = async (input) => {
  const { projectId, actor, about, items, merge } = input;
  const refusals: Refusal[] = [];
  const criteria = items.map((i) => ({ body: i.text }));
  const reason = `Settled in POC room ${merge.roomId}: ${items.length} item${items.length === 1 ? '' : 's'}, merged into ${merge.into} as ${merge.sha.slice(0, 12)}`;
  let requirementId: string | null = null;
  let key: string | null = null;
  let revision: number | null = null;
  if (about.kind === 'requirement') {
    const row = await rowIn(db, projectId, about.key);
    const live = await liveCriteriaOf(row.id);
    const head = row.currentRevision;
    const kind = await headKindOf(row.id, head);
    const written = await writeRevision({
      projectId,
      ref: row.id,
      actor,
      baseRevision: head,
      write: {
        reason,
        criteria: [...live.map((c) => ({ code: c.code, body: c.body, form: c.form })), ...criteria],
        ...(kind === null ? { kind: 'screen' as const } : {}),
      },
    });
    if (written.ok) {
      requirementId = row.id;
      key = about.key;
      revision = await latestRevisionOf(row.id);
    } else {
      refusals.push(...firstOf(written.refusals, 'REQUIREMENT_REFUSED'));
    }
  } else {
    const started = await createRequirement({
      projectId,
      actor,
      title: about.title,
      write: { reason: `${reason}; started from ${about.key}`, criteria, kind: 'screen' },
    });
    if (started.ok) {
      requirementId = started.requirement.id;
      key = started.requirement.key;
      revision = 1;
    } else {
      refusals.push(...firstOf(started.refusals, 'REQUIREMENT_REFUSED'));
    }
  }
  if (requirementId !== null && revision !== null) {
    const drawn = await writePicture({
      projectId,
      ref: requirementId,
      actor,
      revision,
      body: { kind: 'preview', alt: input.alt, content: input.content },
    });
    if (!drawn.ok) refusals.push(...firstOf(drawn.refusals, 'REQUIREMENT_PICTURE_REFUSED'));
  }
  let issue: { id: string } | null = null;
  try {
    const filed = await createIssue(
      {
        projectId,
        title: `Verify, review and clean the POC of ${key ?? about.key} merged into ${merge.into}`,
        // what the merge left owed is the issue's body; its plan is the plan step's to write
        description: followUpBody({ requirement: key ?? about.key, merge, items }),
        priority: 'high',
      },
      {
        createdById: actor.userId,
        createdByDeviceId: null,
        createdVia: 'web',
        actor: { type: 'user', id: actor.userId, agency: actor.agency },
      },
    );
    // no detector key is passed, so a create never dedupes; one that did would be named, never dropped
    if (filed.deduped) {
      refusals.push({
        code: 'ROOM_FOLLOW_UP_NOT_FILED',
        detail: `the follow-up issue was taken as ${filed.existingIssueDisplayId ?? filed.existingIssueId}, already filed`,
      });
    } else {
      issue = filed.issue;
    }
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    refusals.push({
      code: 'ROOM_FOLLOW_UP_NOT_FILED',
      detail: `the follow-up issue could not be filed: ${cause ?? (err as Error).message}`.slice(
        0,
        2000,
      ),
    });
  }
  if (issue && key !== null) {
    const linked = await linkIssue({ projectId, ref: key, actor, issue: issue.id });
    if (!linked.ok) refusals.push(...firstOf(linked.refusals, 'REQUIREMENT_LINK_REFUSED'));
  }
  return {
    requirement: key,
    revision,
    issue: issue ? { id: issue.id, displayId: null } : null,
    refusals,
  };
};

export const roomSettleWriter: RoomSettleWriter = { refusal, write };
