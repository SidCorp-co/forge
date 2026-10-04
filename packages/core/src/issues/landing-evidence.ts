/**
 * What counts as evidence that an issue's work landed, per project shape — the ONE answer.
 *
 * Every door that decides whether a mark is enough reads it here: the close gate
 * (`merged-at.ts`), the release-record blocker and the mark writer. A second place deciding it is
 * how a project gets asked for the sha of a branch it never moves (ISS-1327):
 * docs/modules/issues/merge-mark.md.
 */

import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { projectConfigDocuments } from '../db/schema-project-config.js';
import type { ProjectDocument } from '../project-config/schema.js';
import {
  describeMergeMark,
  type MergeMarkColumns,
  type MergeMarkKind,
  mergeMarkKindOf,
} from './merge-record.js';

/** `git`: the work lands as commits. `outside_git`: it lands as a live resource, a CMS entry, a
 *  storefront change — the repository, where there is one, holds none of it. */
export type LandingShape = 'git' | 'outside_git';

type SourceType = ProjectDocument['source']['type'];

const SHAPE_OF_SOURCE: Readonly<Record<SourceType, LandingShape>> = {
  git: 'git',
  storefront: 'outside_git',
  none: 'outside_git',
};

/** Why no shape-dependent mark can be judged on a project that has no project document. */
export const SOURCE_UNDECLARED =
  'this project declares no project document, so its `source.type` — whether its work lands in git — is unknown and only a merge Forge observed can be judged. Declare it with PUT /api/projects/:id/config (`source.type` `git`, `storefront` or `none`)';

/** `null` where the project declares no document. A stored type no schema admits is refused by name. */
export function landingShapeOf(sourceType: string | null): LandingShape | null {
  if (sourceType === null) return null;
  const shape = (SHAPE_OF_SOURCE as Record<string, LandingShape | undefined>)[sourceType];
  if (!shape) {
    throw new Error(
      `source.type \`${sourceType}\` is not one of ${Object.keys(SHAPE_OF_SOURCE)
        .map((k) => `\`${k}\``)
        .join(', ')}, ` +
        'so whether its work lands in git is unknown and no mark can be judged against it',
    );
  }
  return shape;
}

/** The shape, where a door cannot proceed without one. */
export function requireLandingShape(shape: LandingShape | null): LandingShape {
  if (shape === null) throw new Error(SOURCE_UNDECLARED);
  return shape;
}

/** Which marks count as landed, by shape. `git` keeps the amnesty accepting a claim (its price:
 *  docs/modules/issues/merge-mark.md); on `outside_git` a bare timestamp names nothing landed. */
export const LANDINGS_ACCEPTED: Readonly<Record<LandingShape, readonly MergeMarkKind[]>> = {
  git: ['asserted', 'observed'],
  outside_git: ['landed', 'observed'],
};

/** What every shape accepts, which is all an undeclared project's mark can be judged by. */
const ACCEPTED_UNDER_EVERY_SHAPE: readonly MergeMarkKind[] = LANDINGS_ACCEPTED.git.filter((k) =>
  LANDINGS_ACCEPTED.outside_git.includes(k),
);

export const MERGED_LANDING_MAX = 2000;

/** The landing a mark names: text, because a URL or a CMS entry is not a sha. */
export const mergedLandingSchema = z
  .string()
  .trim()
  .min(1, 'landing must name where the work landed — a URL, a CMS entry, a storefront resource')
  .max(MERGED_LANDING_MAX, `landing must be at most ${MERGED_LANDING_MAX} characters`);

/** How work that did land is claimed on this shape, written once for every refusal naming it.
 *  `held` is the mark already on the row: the first stamp wins, so a bare one is cleared first. */
export function landingRoute(shape: LandingShape | null, held: MergeMarkKind = 'unmarked'): string {
  if (shape === null) {
    return `Declare the project's \`source.type\` first with PUT /api/projects/:id/config, then mark it merged where the work landed.`;
  }
  if (shape === 'git') {
    return (
      'Where the work DID land outside the pipeline, claim it first with `POST /api/issues/:id/merge` ' +
      'naming where it landed.'
    );
  }
  const clear =
    held === 'asserted'
      ? 'This issue already carries a mark naming no landing, and the first stamp wins, so `unmark` ' +
        'it first (`DELETE /api/issues/:id/merge`, or Unmark on the rail). '
      : '';
  return (
    clear +
    "This project's work lands outside git (`source.type` is not `git`), so claim it with " +
    '`POST /api/issues/:id/merge` carrying `landing` — the live URL, CMS entry or storefront resource the ' +
    'work now is (or "Where it landed" on the issue\'s ' +
    'Mark merged rail). A mark naming no landing is not evidence here, and a commit ' +
    'is not asked for.'
  );
}

/** Why this mark is not evidence of a landing on this shape, or `null` where it is. */
export function landingShortfall(row: MergeMarkColumns, shape: LandingShape | null): string | null {
  const kind = mergeMarkKindOf(row);
  if (shape === null) {
    if (ACCEPTED_UNDER_EVERY_SHAPE.includes(kind)) return null;
    const held = describeMergeMark({
      kind,
      commitSha: row.mergedCommitSha,
      landing: row.mergedLanding,
    });
    return `${held}, and ${SOURCE_UNDECLARED}`;
  }
  const accepted = LANDINGS_ACCEPTED[shape];
  if (accepted.includes(kind)) return null;
  const wanted = accepted.map((k) => `\`${k}\``).join(' or ');
  // Outside git a mark lacks a landing, never a commit: no commit is that shape's normal record.
  const held =
    shape === 'outside_git' && kind === 'asserted'
      ? "this issue's mark names no landing: `merged_landing` is empty"
      : describeMergeMark({ kind, commitSha: row.mergedCommitSha, landing: row.mergedLanding });
  return `${held}, and a project whose work lands ${shape === 'git' ? 'in git' : 'outside git'} accepts ${wanted}`;
}

/** The mark writer's refusal for this shape, or `null` where the mark may be written. */
export function landingMarkRefusal(args: {
  shape: LandingShape;
  landing: string | null;
  observed: boolean;
}): { code: 'LANDING_REQUIRED' | 'LANDING_NOT_THIS_SHAPE'; detail: string } | null {
  if (args.shape === 'git' && args.landing) {
    return {
      code: 'LANDING_NOT_THIS_SHAPE',
      detail:
        '`landing` names where work landed OUTSIDE git, and this project lands its work in git ' +
        '(`source.type` is `git`), so nothing was marked. Send the mark without `landing`, naming ' +
        'the commit with `commit` where you have one.',
    };
  }
  if (args.shape === 'outside_git' && !args.landing && !args.observed) {
    return {
      code: 'LANDING_REQUIRED',
      detail:
        "this project's work lands outside git (`source.type` is not `git`) and Forge holds no merged pull " +
        'request for this issue, so a mark must name where the work landed and nothing was ' +
        'marked. Send `landing` — the live URL, CMS entry or storefront resource the work now is.',
    };
  }
  return null;
}

/** `target` names the branch a mark merged through, so only a shape that moves branches owes one. */
export function markTargetRequired(shape: LandingShape): boolean {
  return shape === 'git';
}

/** A landing the stamp did not record because a mark already stands, or `null` where it did.
 *  The first stamp wins for the landing as for `merged_at`, so a correction is refused by name
 *  rather than answered as a success that dropped it: docs/modules/issues/merge-mark.md. */
export function standingMarkRefusal(args: {
  sent: string | null;
  wrote: boolean;
  held: MergeMarkColumns;
}): { code: 'MARK_ALREADY_STANDS'; detail: string; details: Record<string, unknown> } | null {
  if (!args.sent || args.wrote) return null;
  const heldLanding = args.held.mergedLanding ?? null;
  if (heldLanding === args.sent) return null;
  const heldKind = mergeMarkKindOf(args.held);
  const stands = heldLanding
    ? `this issue's mark already names ${heldLanding} as where the work landed`
    : `this issue already carries a mark (${heldKind}) that names no landing`;
  return {
    code: 'MARK_ALREADY_STANDS',
    detail:
      `${stands}, and the first mark stands, so ${args.sent} was not recorded and nothing ` +
      'changed. To change it, `unmark` (Unmark on the rail), then mark again with the landing ' +
      'that is right.',
    details: { heldLanding, heldKind, sentLanding: args.sent, route: ['unmark', 'mark_merged'] },
  };
}

type ShapeExecutor = Pick<Db, 'select'>;

const sourceTypeOf = sql<string | null>`${projectConfigDocuments.document} -> 'source' ->> 'type'`;

/** The shape of the project an issue belongs to, read in one statement with the mark. */
export async function readLandingEvidence(
  executor: ShapeExecutor,
  issueId: string,
): Promise<{ columns: MergeMarkColumns; shape: LandingShape | null } | null> {
  const [row] = await executor
    .select({
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedLanding: issues.mergedLanding,
      sourceType: sourceTypeOf,
    })
    .from(issues)
    .leftJoin(projectConfigDocuments, eq(projectConfigDocuments.projectId, issues.projectId))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) return null;
  const { sourceType, ...columns } = row;
  return { columns, shape: landingShapeOf(sourceType) };
}

export async function readLandingShape(
  executor: ShapeExecutor,
  projectId: string,
): Promise<LandingShape | null> {
  const [row] = await executor
    .select({ sourceType: sourceTypeOf })
    .from(projectConfigDocuments)
    .where(eq(projectConfigDocuments.projectId, projectId))
    .limit(1);
  return landingShapeOf(row?.sourceType ?? null);
}
