/**
 * What counts as evidence that an issue's work landed, per project shape — the ONE answer.
 *
 * Every door that decides whether a mark is enough reads it here: the close gate
 * (`merged-at.ts`), the `merged_mark` entry criterion, the release-record blocker and the mark
 * writer. A second place deciding it is how a project gets asked for the sha of a branch it never
 * moves (ISS-1327): docs/modules/issues/merge-mark.md.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { issues, type ProjectKind, projectKinds, projects } from '../db/schema.js';
import {
  describeMergeMark,
  type MergeMarkColumns,
  type MergeMarkKind,
  mergeMarkKindOf,
} from './merge-record.js';

/** `git`: the work lands as commits. `outside_git`: it lands as a live resource, a CMS entry, a
 *  storefront change — the repository, where there is one, holds none of it. */
export type LandingShape = 'git' | 'outside_git';

const SHAPE_OF_KIND: Readonly<Record<ProjectKind, LandingShape>> = {
  standard: 'git',
  // The store is the source of truth and the repo is optional (`projectKinds` in schema.ts).
  website: 'outside_git',
};

export class UnknownProjectKindError extends Error {
  constructor(
    readonly kind: string,
    readonly projectId?: string,
  ) {
    super(
      `${projectId ? `project ${projectId}'s ` : 'project '}kind \`${kind}\` is not one of ` +
        `${projectKinds.map((k) => `\`${k}\``).join(', ')}, so whether its work lands in git is ` +
        'unknown and no mark can be judged against it. Set the kind to one of them (`kind` on ' +
        '`PATCH /api/projects/:id`), then mark again',
    );
    this.name = 'UnknownProjectKindError';
  }
}

/** `projects.kind` is plain text in the table, so a value no route writes is refused by name. */
export function landingShapeOf(kind: string, projectId?: string): LandingShape {
  const shape = (SHAPE_OF_KIND as Record<string, LandingShape | undefined>)[kind];
  if (!shape) throw new UnknownProjectKindError(kind, projectId);
  return shape;
}

/** Which marks count as landed, by shape. `git` keeps the amnesty accepting a claim (its price:
 *  docs/modules/issues/merge-mark.md); on `outside_git` a bare timestamp names nothing landed. */
export const LANDINGS_ACCEPTED: Readonly<Record<LandingShape, readonly MergeMarkKind[]>> = {
  git: ['asserted', 'observed'],
  outside_git: ['landed', 'observed'],
};

export const MERGED_LANDING_MAX = 2000;

/** The landing a mark names: text, because a URL or a CMS entry is not a sha. */
export const mergedLandingSchema = z
  .string()
  .trim()
  .min(1, 'landing must name where the work landed — a URL, a CMS entry, a storefront resource')
  .max(MERGED_LANDING_MAX, `landing must be at most ${MERGED_LANDING_MAX} characters`);

/** How work that did land is claimed on this shape, written once for every refusal naming it.
 *  `held` is the mark already on the row: the first stamp wins, so a bare one is cleared first. */
export function landingRoute(shape: LandingShape, held: MergeMarkKind = 'unmarked'): string {
  if (shape === 'git') {
    return (
      'Where the work DID land outside the pipeline, claim it first with `forge_issues` ' +
      '`mark_merged` naming where it landed, then close.'
    );
  }
  const clear =
    held === 'asserted'
      ? 'This issue already carries a mark naming no landing, and the first stamp wins, so `unmark` ' +
        'it first (`forge_issues` `unmark`, or Unmark on the rail). '
      : '';
  return (
    clear +
    "This project's work lands outside git (kind `website`), so claim it with `forge_issues` " +
    '`mark_merged` carrying `data.landing` — the live URL, CMS entry or storefront resource the ' +
    'work now is (`landing` on `POST /api/issues/:id/merge`, or "Where it landed" on the issue\'s ' +
    'Mark merged rail) — then close. A mark naming no landing is not evidence here, and a commit ' +
    'is not asked for.'
  );
}

/** Why this mark is not evidence of a landing on this shape, or `null` where it is. */
export function landingShortfall(row: MergeMarkColumns, shape: LandingShape): string | null {
  const kind = mergeMarkKindOf(row);
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
        '(kind is not `website`), so nothing was marked. Send the mark without `landing`, naming ' +
        'the commit with `commit` where you have one.',
    };
  }
  if (args.shape === 'outside_git' && !args.landing && !args.observed) {
    return {
      code: 'LANDING_REQUIRED',
      detail:
        "this project's work lands outside git (kind `website`) and Forge holds no merged pull " +
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

/** The shape of the project an issue belongs to, read in one statement with the mark. */
export async function readLandingEvidence(
  executor: ShapeExecutor,
  issueId: string,
): Promise<{ columns: MergeMarkColumns; shape: LandingShape } | null> {
  const [row] = await executor
    .select({
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedLanding: issues.mergedLanding,
      kind: projects.kind,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) return null;
  const { kind, ...columns } = row;
  return { columns, shape: landingShapeOf(kind) };
}

export async function readLandingShape(
  executor: ShapeExecutor,
  projectId: string,
): Promise<LandingShape> {
  const [row] = await executor
    .select({ kind: projects.kind })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) throw new Error(`no project row for ${projectId}, so its landing shape is unknown`);
  return landingShapeOf(row.kind, projectId);
}
