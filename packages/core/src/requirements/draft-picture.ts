/**
 * The picture a revision write carries (REQ-35 BC-10; Requirement lifecycle r14 `revision.written`
 * and `picture.drawn or replaced`). It meets the rules a picture drawn on the page meets — its kind
 * is the requirement's, a rule's table rows are whole, it has a text alternative — before anything
 * is written. The assistant's draft must also leave its revision showing a picture, its own or the
 * one it carries from the head; only the assistant's doors ask that (`mustDraw`), so a person's
 * draft never needs one (BC-14).
 */

import {
  type DraftPicture,
  describePicture,
  PICTURE_KIND_OF,
  type PictureKind,
  type RequirementKind,
} from '@forge/contracts/requirement-pictures';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import {
  requirementPictures,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { altRefusal, kindMismatchRefusal, rowRefusals } from './picture-rules.js';
import type { RequirementRefusal } from './rules.js';

/** What the revision a write lands as shows before the write's own kind and picture are applied. */
export interface Landing {
  /** REQ-n, or how a requirement not yet numbered is named. */
  key: string;
  revision: number;
  kind: RequirementKind | null;
  /** The kind of picture it shows: the head's it carries, or the open draft's own; null for none. */
  shows: PictureKind | null;
}

/** A requirement not created yet lands as its revision 1, holding nothing. */
export const NEW_REQUIREMENT: Landing = {
  key: 'the new requirement',
  revision: 1,
  kind: null,
  shows: null,
};

const DRAWN_AS: Record<PictureKind, string> = {
  flow: 'a flow',
  example_table: 'an example table',
  wireframe: 'a wireframe',
  chart: 'a sample chart',
};

const KINDS_TAKE =
  'process takes a flow, rule an example table, screen a wireframe, report a sample chart';

const at = (path: string) => (r: RequirementRefusal) => ({ ...r, path: `${path}${r.path}` });

/** The draft leaves its revision with no picture: the assistant's draft names its kind and draws. */
function notDrawnRefusal(landing: Landing, kind: RequirementKind | null): RequirementRefusal {
  const where = `${landing.key} r${landing.revision}`;
  return {
    code: 'REQUIREMENT_PICTURE_NOT_DRAWN',
    path: '/picture',
    detail:
      kind === null
        ? `${where} would name no kind and show no picture; the assistant's draft names its kind and draws its picture in the same write: kind (process, rule, screen or report) and picture { kind, content } (${KINDS_TAKE}).`
        : `${where} is a ${kind} requirement and would show no picture; the assistant's draft draws ${DRAWN_AS[PICTURE_KIND_OF[kind]]} (picture kind ${PICTURE_KIND_OF[kind]}) in the same write.`,
  };
}

/** A picture drawn in a write that names no kind: the kind comes in the same write. */
function noKindRefusal(landing: Landing): RequirementRefusal {
  return {
    code: 'REQUIREMENT_PICTURE_KIND_MISMATCH',
    path: '/kind',
    detail: `${landing.key} r${landing.revision} names no kind, so no picture fits it; name its kind in the same write (${KINDS_TAKE}).`,
  };
}

/**
 * What a write carrying `kind` and `picture` onto `landing` is refused for, nothing written: the
 * picture's kind, its rows and its text alternative, and, where `mustDraw`, a revision left showing
 * none. A text alternative left out is written from the content, so only a blank one is refused.
 */
export function draftPictureRefusals(
  landing: Landing,
  write: { kind?: RequirementKind | null | undefined; picture?: DraftPicture | undefined },
  mustDraw: boolean,
): RequirementRefusal[] {
  const kind = write.kind === undefined ? landing.kind : write.kind;
  const { picture } = write;
  if (!picture) {
    const shown = kind !== null && landing.shows === PICTURE_KIND_OF[kind];
    return mustDraw && !shown ? [notDrawnRefusal(landing, kind)] : [];
  }
  const mismatch =
    kind === null ? null : kindMismatchRefusal(landing.key, landing.revision, kind, picture.kind);
  const fit = kind === null ? noKindRefusal(landing) : mismatch && at('/picture')(mismatch);
  const rows = picture.kind === 'example_table' ? rowRefusals(picture.content) : [];
  const alt = altRefusal(picture.alt ?? describePicture(picture));
  return [
    ...(fit ? [fit] : []),
    ...rows.map(at('/picture')),
    ...(alt ? [at('/picture')(alt)] : []),
  ];
}

async function pictureKindIn(tx: Tx, pictureId: string | null): Promise<PictureKind | null> {
  if (pictureId === null) return null;
  const [p] = await tx
    .select({ kind: requirementPictures.kind })
    .from(requirementPictures)
    .where(eq(requirementPictures.id, pictureId));
  return (p?.kind as PictureKind | undefined) ?? null;
}

/**
 * Where a write on `requirementId` lands: revision `revision` rewritten in place, or, with none, a
 * new revision on `head` that carries the head's kind and picture.
 */
export async function landingIn(
  tx: Tx,
  requirementId: string,
  onto: { revision: number } | { head: number | null },
): Promise<Landing> {
  const [req] = await tx
    .select({ reqSeq: requirements.reqSeq })
    .from(requirements)
    .where(eq(requirements.id, requirementId));
  if (!req) throw new Error(`requirements: ${requirementId} has no row`);
  const key = requirementKey(req.reqSeq);
  const source = 'revision' in onto ? onto.revision : onto.head;
  const [held] =
    source === null
      ? []
      : await tx
          .select({ kind: requirementRevisions.kind, pictureId: requirementRevisions.pictureId })
          .from(requirementRevisions)
          .where(
            and(
              eq(requirementRevisions.requirementId, requirementId),
              eq(requirementRevisions.revision, source),
            ),
          );
  const [{ next } = { next: 1 }] =
    'revision' in onto
      ? [{ next: onto.revision }]
      : await tx
          .select({
            next: sql<number>`coalesce(max(${requirementRevisions.revision}), 0)::int + 1`,
          })
          .from(requirementRevisions)
          .where(eq(requirementRevisions.requirementId, requirementId));
  return {
    key,
    revision: next,
    kind: (held?.kind as RequirementKind | null | undefined) ?? null,
    shows: await pictureKindIn(tx, held?.pictureId ?? null),
  };
}
