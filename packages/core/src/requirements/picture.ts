/**
 * A revision's kind and its one picture (REQ-35; Requirement lifecycle r14 steps picture,
 * picture_none and picture_shown, edge kind.corrected). Any holder of project.write writes either;
 * the picture shows at once with no accept, each write is a new history row, and nothing here moves
 * a status, a baseline or a plan. Each write runs in one transaction under the project's requirement lock.
 */

import {
  PICTURE_KIND_OF,
  type PictureKind,
  type RequirementKind,
  type WritePictureRequest,
} from '@forge/contracts/requirement-pictures';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  type RevisionState,
  requirementPictures,
  requirementRevisions,
} from '../db/schema-requirements.js';
import { dataPolicyOf, storedDeep, storedText } from '../lib/data-egress.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import {
  altRefusal,
  kindMismatchRefusal,
  rowRefusals,
  supersededRefusal,
} from './picture-rules.js';
import { type RequirementActor, rowIn } from './read.js';
import {
  answer,
  inTx,
  lockRequirements,
  type RequirementOutcome,
  revisionIn,
  revisionWhere,
} from './write-tx.js';

/** The kind a picture of `pictureId` was drawn as, or null where there is none. */
async function pictureKindOf(tx: Tx, pictureId: string | null) {
  if (pictureId === null) return null;
  const [p] = await tx
    .select({ kind: requirementPictures.kind })
    .from(requirementPictures)
    .where(eq(requirementPictures.id, pictureId));
  return p?.kind ?? null;
}

/** Whether a revision of `kind` still shows the picture it holds: only one drawn for that kind. */
export async function pictureFitsKind(
  tx: Tx,
  pictureId: string | null,
  kind: RequirementKind | null,
): Promise<boolean> {
  if (pictureId === null || kind === null) return false;
  return (await pictureKindOf(tx, pictureId)) === PICTURE_KIND_OF[kind];
}

/**
 * The open revision that follows the head's picture, if any: a new revision of the head's kind
 * carries that picture until it is redrawn itself (r14 `picture_shown`), so it is the open (draft or
 * proposed) revision whose kind takes `picture` and which holds no picture drawn for it — the one it
 * shows was drawn for another revision, or it shows none. A picture drawn on it is its own and stays.
 */
async function followerOf(tx: Tx, requirementId: string, picture: PictureKind) {
  const [open] = await tx
    .select({
      revision: requirementRevisions.revision,
      kind: requirementRevisions.kind,
      drawnFor: requirementPictures.drawnFor,
    })
    .from(requirementRevisions)
    .leftJoin(requirementPictures, eq(requirementPictures.id, requirementRevisions.pictureId))
    .where(
      and(
        eq(requirementRevisions.requirementId, requirementId),
        inArray(requirementRevisions.state, ['draft', 'proposed']),
      ),
    );
  if (!open || open.kind === null) return null;
  if (PICTURE_KIND_OF[open.kind as RequirementKind] !== picture) return null;
  return open.drawnFor === open.revision ? null : open.revision;
}

/**
 * Draws or replaces revision `revision`'s picture; the one it showed stays in the history. Drawn on
 * the head, it is shown by the open revision that follows the head too (`followerOf`).
 */
export async function writePicture(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  revision: number;
  body: WritePictureRequest;
}): Promise<RequirementOutcome> {
  const { projectId, actor, body } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const early = [
    altRefusal(body.alt),
    ...(body.kind === 'example_table' ? rowRefusals(body.content) : []),
  ].filter((r) => r !== null);
  if (early.length) return { ok: false, refusals: early };
  const level = await dataPolicyOf(projectId);
  const row = await rowIn(db, projectId, input.ref);
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const target = await revisionIn(tx, current, input.revision);
    const key = requirementKey(current.reqSeq);
    const refused =
      supersededRefusal(
        key,
        target.revision,
        target.state as RevisionState,
        current.currentRevision,
        'picture',
      ) ??
      kindMismatchRefusal(
        key,
        target.revision,
        (target.kind as RequirementKind | null) ?? null,
        body.kind,
      );
    if (refused) return [refused];
    const [drawn] = await tx
      .insert(requirementPictures)
      .values({
        requirementId: row.id,
        drawnFor: target.revision,
        kind: body.kind,
        content: storedDeep(level, body.content),
        alt: storedText(level, body.alt.trim()).text,
        writtenBy: actor.userId,
        writtenAgency: actor.agency,
      })
      .returning({ id: requirementPictures.id });
    if (!drawn) throw new Error('requirements: the picture insert returned no row');
    await tx
      .update(requirementRevisions)
      .set({ pictureId: drawn.id })
      .where(revisionWhere(row.id, target.revision));
    if (target.state === 'current') {
      const follower = await followerOf(tx, row.id, body.kind);
      if (follower !== null) {
        await tx
          .update(requirementRevisions)
          .set({ pictureId: drawn.id })
          .where(revisionWhere(row.id, follower));
      }
    }
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}

/**
 * Sets or corrects revision `revision`'s kind. A picture drawn for another kind no longer fits, so
 * the revision is left with none (r14 `kind.corrected`); the picture itself stays in the history.
 */
export async function writeKind(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  revision: number;
  kind: RequirementKind | null;
}): Promise<RequirementOutcome> {
  const { projectId, actor, kind } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const target = await revisionIn(tx, current, input.revision);
    const refused = supersededRefusal(
      requirementKey(current.reqSeq),
      target.revision,
      target.state as RevisionState,
      current.currentRevision,
      'kind',
    );
    if (refused) return [refused];
    if (target.kind === kind) return null;
    const keeps = await pictureFitsKind(tx, target.pictureId, kind);
    await tx
      .update(requirementRevisions)
      .set({ kind, ...(keeps ? {} : { pictureId: null }) })
      .where(revisionWhere(row.id, target.revision));
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}
