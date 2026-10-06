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
import { type Db, db } from '../db/client.js';
import {
  issues,
  type LandingShape,
  landingShapes,
  type ProjectKind,
  projectKinds,
  projects,
} from '../db/schema.js';
import {
  describeMergeMark,
  type MergeMarkColumns,
  type MergeMarkKind,
  mergeMarkKindOf,
} from './merge-record.js';

export type { LandingShape };

/** Where one issue's work lands, and whether the issue said so itself (`issues.declared_landing_shape`)
 *  or its project's kind answers for it. Every sentence a door prints names the one that decided. */
export interface Lane {
  shape: LandingShape;
  declared: boolean;
}

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

const LANDING_SHAPE_WRITE =
  "`landingShape` must be `git` or `outside_git` — where this issue's own work lands — or null " +
  "to answer the project's shape";

/** The issue's own declaration as a write takes it; a value outside the two shapes is refused by name. */
export const landingShapeInputSchema = z
  .enum(landingShapes, {
    error: (issue) => `${LANDING_SHAPE_WRITE}; got ${JSON.stringify(issue.input)}`,
  })
  .nullable();

/** The one precedence: the issue's declaration where it holds one, else `projectShape()`. The
 *  column's CHECK holds the two shapes, so a value outside them is refused rather than guessed. */
export function laneFrom(
  declared: string | null | undefined,
  projectShape: () => LandingShape,
): Lane {
  if (declared == null) return { shape: projectShape(), declared: false };
  if (!(landingShapes as readonly string[]).includes(declared)) {
    throw new Error(
      `issue declares landing shape \`${declared}\`, which is neither \`git\` nor \`outside_git\`; ` +
        'the column CHECK refuses it, so a write went around it. Clear it or set one of the two',
    );
  }
  return { shape: declared as LandingShape, declared: true };
}

/** `laneFrom`, the project's shape read off its kind. */
export function laneOf(args: {
  declared: string | null | undefined;
  kind: string;
  projectId?: string;
}): Lane {
  return laneFrom(args.declared, () => landingShapeOf(args.kind, args.projectId));
}

/** `laneOf`, or `null` where nothing is declared and the project's kind is none Forge knows. */
export function laneOrNull(
  declared: string | null | undefined,
  kind: string | undefined,
): Lane | null {
  if (
    declared == null &&
    (kind === undefined || !(projectKinds as readonly string[]).includes(kind))
  ) {
    return null;
  }
  return laneOf({ declared, kind: kind ?? '' });
}

/** Who decided where the work lands, as a clause — `opening` capitalises it to start a sentence. */
export function whereItLands(lane: Lane, opening = false): string {
  const where = lane.shape === 'git' ? 'in git' : 'outside git';
  const clause = lane.declared
    ? `this issue's work lands ${where} (declared on the issue, \`landingShape\`)`
    : lane.shape === 'git'
      ? 'this project lands its work in git (kind is not `website`)'
      : "this project's work lands outside git (kind `website`)";
  return opening ? clause.charAt(0).toUpperCase() + clause.slice(1) : clause;
}

/** How a git lane's issue whose change lands no file in the repository says so, for every refusal
 *  that meets one sending a landing or with nothing to show. */
export const DECLARE_OUTSIDE_GIT =
  "Where this change lands no file in the repository — a deployment's settings, a redeploy, a " +
  'live resource — declare it on the issue first (`landingShape: outside_git` on ' +
  '`PATCH /api/issues/:id`, or `forge_issues` `update`), then mark it with `landing`.';

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

/** How work that did land is claimed on this lane, written once for every refusal naming it.
 *  `held` is the mark already on the row: the first stamp wins, so a bare one is cleared first.
 *  `then` is the act the refused caller takes once the claim stands: the close, or the status. */
export function landingRoute(
  lane: Lane,
  held: MergeMarkKind = 'unmarked',
  then = 'close',
): string {
  if (lane.shape === 'git') {
    return (
      'Where the work DID land outside the pipeline, claim it first with `forge_issues` ' +
      '`mark_merged`, naming the commit it landed at in `data.commit` where there is one, then ' +
      `${then}. ${DECLARE_OUTSIDE_GIT}`
    );
  }
  const clear =
    held === 'asserted'
      ? 'This issue already carries a mark naming no landing, and the first stamp wins, so `unmark` ' +
        'it first (`forge_issues` `unmark`, or Unmark on the rail). '
      : '';
  return (
    clear +
    `${whereItLands(lane, true)}, so claim it with \`forge_issues\` ` +
    '`mark_merged` carrying `data.landing` — the live URL, CMS entry or storefront resource the ' +
    'work now is (`landing` on `POST /api/issues/:id/merge`, or "Where it landed" on the issue\'s ' +
    `Mark merged rail) — then ${then}. A mark naming no landing is not evidence here, and a ` +
    'commit is not asked for.'
  );
}

/** Why this mark is not evidence of a landing on this lane, or `null` where it is. */
export function landingShortfall(row: MergeMarkColumns, lane: Lane): string | null {
  const kind = mergeMarkKindOf(row);
  const accepted = LANDINGS_ACCEPTED[lane.shape];
  if (accepted.includes(kind)) return null;
  const wanted = accepted.map((k) => `\`${k}\``).join(' or ');
  // Outside git a mark lacks a landing, never a commit: no commit is that shape's normal record.
  const held =
    lane.shape === 'outside_git' && kind === 'asserted'
      ? "this issue's mark names no landing: `merged_landing` is empty"
      : describeMergeMark({ kind, commitSha: row.mergedCommitSha, landing: row.mergedLanding });
  const where = lane.shape === 'git' ? 'in git' : 'outside git';
  const whose = lane.declared
    ? `an issue declared to land ${where}`
    : `a project whose work lands ${where}`;
  return `${held}, and ${whose} accepts ${wanted}`;
}

/** The mark writer's refusal for this lane, or `null` where the mark may be written. */
export function landingMarkRefusal(args: {
  lane: Lane;
  landing: string | null;
  observed: boolean;
}): { code: 'LANDING_REQUIRED' | 'LANDING_NOT_THIS_SHAPE'; detail: string } | null {
  if (args.lane.shape === 'git' && args.landing) {
    return {
      code: 'LANDING_NOT_THIS_SHAPE',
      detail:
        `\`landing\` names where work landed OUTSIDE git, and ${whereItLands(args.lane)}, so ` +
        'nothing was marked. Send the mark without `landing`, naming the commit with `commit` ' +
        `where you have one. ${DECLARE_OUTSIDE_GIT}`,
    };
  }
  if (args.lane.shape === 'outside_git' && !args.landing && !args.observed) {
    return {
      code: 'LANDING_REQUIRED',
      detail:
        `${whereItLands(args.lane, true)} and Forge holds no merged pull request for this issue, so a ` +
        'mark must name where the work landed and nothing was marked. Send `landing` — the live ' +
        'URL, CMS entry or storefront resource the work now is.',
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

/** Why `landingShape` was not changed: a mark stands, and it was judged on the lane it was made
 *  under, so changing the lane would re-judge it in silence. `unmark` is the way through. `held`
 *  null is an issue that declared nothing, whose lane was `project`, its project's shape. */
export function landingShapeMarkStandsDetail(args: {
  held: LandingShape | null;
  sent: LandingShape | null;
  project: LandingShape;
  mark: MergeMarkKind;
}): string {
  const madeUnder =
    args.held === null
      ? `while the issue declared nothing and its project's shape (\`${args.project}\`) applied`
      : `while the issue declared \`${args.held}\``;
  const refused =
    args.sent === null
      ? `\`landingShape\` was not cleared back to the project's shape (\`${args.project}\`)`
      : `\`landingShape\` was not changed to \`${args.sent}\``;
  return (
    `this issue carries a merged mark (\`${args.mark}\`), made ${madeUnder}, and a mark is judged ` +
    `on the lane it was made under, so ${refused} and nothing was written. \`unmark\` it first ` +
    '(`forge_issues` `unmark`, or Unmark on the rail), change `landingShape`, then mark it again ' +
    'on the new lane; a `closed` issue is reopened before it can be unmarked.'
  );
}

type ShapeExecutor = Pick<Db, 'select'>;

/** The mark and the lane of one issue, read in one statement. */
export async function readLandingEvidence(
  executor: ShapeExecutor,
  issueId: string,
): Promise<{ columns: MergeMarkColumns; lane: Lane } | null> {
  const [row] = await executor
    .select({
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedLanding: issues.mergedLanding,
      declared: issues.declaredLandingShape,
      kind: projects.kind,
      projectId: projects.id,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) return null;
  const { kind, declared, projectId, ...columns } = row;
  return { columns, lane: laneOf({ declared, kind, projectId }) };
}

/** The project's own shape, which an issue declaring none answers. */
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

/** The lane's shape as the issue reads serve it; a read reports an unknown kind rather than failing. */
export async function readIssueLandingShape(
  issue: { projectId: string; declaredLandingShape: LandingShape | null },
  executor: ShapeExecutor = db,
): Promise<LandingShape | null> {
  const [row] =
    issue.declaredLandingShape == null
      ? await executor
          .select({ kind: projects.kind })
          .from(projects)
          .where(eq(projects.id, issue.projectId))
          .limit(1)
      : [];
  return laneOrNull(issue.declaredLandingShape, row?.kind)?.shape ?? null;
}

/** What the issue declares now, read back where a stamp wrote nothing; `null` for no such row. */
export async function readDeclaredLandingShape(
  executor: ShapeExecutor,
  issueId: string,
): Promise<{ declared: LandingShape | null } | null> {
  const [row] = await executor
    .select({ declared: issues.declaredLandingShape })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row ?? null;
}
