/**
 * A kept idea preview becomes a requirement's picture (REQ-41 BC-16; Requirement lifecycle r14
 * `picture`, which takes a kept preview for a screen). About a requirement it is drawn on the head
 * revision (the open draft where none is current); about a feedback item a new requirement draft is
 * started from it, a screen, and the picture is drawn on that. Core's own picture write does the
 * drawing, so the kind check, the history row and the follower rule are the ones every picture meets.
 */

import type { KeptPreviewPicture } from '@forge/contracts/requirement-pictures';
import { requirementKey } from '@forge/contracts/requirements';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementCriteria, requirementRevisions } from '../db/schema-requirements.js';
import { writePicture } from './picture.js';
import { type RequirementActor, rowIn } from './read.js';
import type { RequirementRefusal } from './rules.js';
import { createRequirement } from './service.js';

export type KeptPreviewAbout =
  | { kind: 'requirement'; key: string }
  | { kind: 'feedback'; key: string; title: string };

export type KeptPreviewDrawn =
  | {
      ok: true;
      requirementId: string;
      key: string;
      revision: number;
      pictureId: string;
      /** A new requirement draft was started from the feedback item. */
      created: boolean;
    }
  | { ok: false; refusals: RequirementRefusal[] };

/** The revision a kept preview is drawn on: the head, else the open draft the requirement still is. */
async function targetRevision(requirementId: string, head: number | null): Promise<number> {
  if (head !== null) return head;
  const [open] = await db
    .select({ revision: requirementRevisions.revision })
    .from(requirementRevisions)
    .where(eq(requirementRevisions.requirementId, requirementId))
    .orderBy(asc(requirementRevisions.revision))
    .limit(1);
  if (!open) throw new Error(`requirements: ${requirementId} holds no revision to draw on`);
  return open.revision;
}

export async function drawKeptPreview(input: {
  projectId: string;
  actor: RequirementActor;
  about: KeptPreviewAbout;
  picture: KeptPreviewPicture;
}): Promise<KeptPreviewDrawn> {
  const { projectId, actor, about, picture } = input;
  let created = false;
  let requirementId: string;
  let revision: number;
  if (about.kind === 'requirement') {
    const row = await rowIn(db, projectId, about.key);
    requirementId = row.id;
    revision = await targetRevision(row.id, row.currentRevision);
  } else {
    const started = await createRequirement({
      projectId,
      actor,
      title: about.title,
      write: { reason: `Started from ${about.key}`, criteria: [], kind: 'screen' },
    });
    if (!started.ok) return started;
    created = true;
    requirementId = started.requirement.id;
    revision = 1;
  }
  const drawn = await writePicture({
    projectId,
    ref: requirementId,
    actor,
    revision,
    body: picture,
  });
  if (!drawn.ok) return drawn;
  const [held] = await db
    .select({ pictureId: requirementRevisions.pictureId })
    .from(requirementRevisions)
    .where(
      and(
        eq(requirementRevisions.requirementId, requirementId),
        eq(requirementRevisions.revision, revision),
      ),
    );
  if (!held?.pictureId)
    throw new Error('requirements: the kept preview was drawn and is not shown');
  const row = await rowIn(db, projectId, requirementId);
  return {
    ok: true,
    requirementId,
    key: requirementKey(row.reqSeq),
    revision,
    pictureId: held.pictureId,
    created,
  };
}

/** The live criteria of a requirement, in code order, as a revision_diff must carry them (code and wording). */
export async function liveCriteriaOf(
  requirementId: string,
): Promise<{ code: string; body: string; form: 'statement' | 'scenario' }[]> {
  const rows = await db
    .select({
      code: requirementCriteria.code,
      body: requirementCriteria.body,
      form: requirementCriteria.form,
    })
    .from(requirementCriteria)
    .where(
      and(
        eq(requirementCriteria.requirementId, requirementId),
        isNull(requirementCriteria.retiredRevision),
      ),
    );
  return rows.sort((a, b) => Number(a.code.slice(3)) - Number(b.code.slice(3)));
}
