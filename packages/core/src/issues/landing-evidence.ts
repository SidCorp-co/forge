/**
 * What a mark is, per project shape, and what it may carry — the ONE answer.
 *
 * Whether work is done is the agent's call (owner, 2026-11-05, ISS-1017): a mark is evidence that the
 * work landed whatever it names, on every shape, and every door that asks whether an issue is marked
 * reads it here: the close and `awaiting_release` (`merged-at.ts`), the release-record blocker and the
 * mark writer. The shape still says how a named commit is read and where a landing's artifacts come
 * from: docs/modules/issues/merge-mark.md.
 */

import {
  designArtifact,
  designLandingRef,
  type LandingArtifact,
  type ReadPaths,
} from '@forge/contracts/landing-artifacts';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Db, db } from '../db/client.js';
import { projectConfigDocuments } from '../db/schema-project-config.js';
import { CLAIMABLE_COMMIT } from './mark-trail.js';
import { describeMergeMark, type MergeMarkColumns, mergeMarkKindOf } from './merge-mark-kind.js';

/** The act that clears a standing mark, as every refusal naming the mark as standing words it. */
export const CLEAR_THE_MARK =
  'clear the mark with `DELETE /api/issues/:id/merge` (Unmark on the rail)';

/**
 * A mark's `commit` that is not the whole sha, or `null` where it is or none was sent. Asked where no
 * host or repository resolved the commit, so the mark records it as the caller's claim: the claim is
 * read only as the whole sha (`mark-trail.ts:CLAIMABLE_COMMIT`), and an abbreviation stamped would be
 * a mark whose claim the release never reads (ISS-575). One a host resolved is stamped whole.
 */
export function wholeCommitRefusal(
  commit: string | undefined,
): { code: 'COMMIT_NOT_WHOLE'; detail: string } | null {
  if (commit === undefined || CLAIMABLE_COMMIT.test(commit)) return null;
  return {
    code: 'COMMIT_NOT_WHOLE',
    detail:
      `commit ${commit} is ${commit.length} characters, and a mark takes the whole 40-character sha ` +
      `the work landed at (\`git rev-parse ${commit}\` prints it), so nothing was marked. An ` +
      'abbreviated sha is refused, never expanded.',
  };
}

/** `git`: the work lands as commits. `outside_git`: it lands as a live resource, a CMS entry, a
 *  storefront change — the repository, where there is one, holds none of it. */
export type LandingShape = 'git' | 'outside_git';

type SourceType = 'git' | 'storefront' | 'none';

const SHAPE_OF_SOURCE: Readonly<Record<SourceType, LandingShape>> = {
  git: 'git',
  storefront: 'outside_git',
  none: 'outside_git',
};

/** Why a project with no project document has no shape to read a mark's evidence by. */
export const SOURCE_UNDECLARED =
  'this project declares no project document, so its `source.type` — whether its work lands in git — is unknown and nothing says how to read the evidence a mark names. Declare it with PUT /api/projects/:id/config (`source.type` `git`, `storefront` or `none`)';

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

export const MERGED_LANDING_MAX = 2000;

/** The landing a mark names: text, because a URL or a CMS entry is not a sha. */
export const mergedLandingSchema = z
  .string()
  .trim()
  .min(1, 'landing must name where the work landed — a URL, a CMS entry, a storefront resource')
  .max(MERGED_LANDING_MAX, `landing must be at most ${MERGED_LANDING_MAX} characters`);

/** How work that did land is claimed, written once for every refusal naming it. */
export const MARK_ROUTE =
  'Where the work DID land, mark it with `POST /api/issues/:id/merge` naming what you have — `commit`, ' +
  '`landing`, `artifacts`, a `liveReading` of where it is live, or a `note` — or nothing at all: the ' +
  "mark is the agent's word that it landed, recorded as given with who said it.";

/** Why this row carries no mark, or `null` where it does: any mark is evidence that the work landed. */
export function landingShortfall(row: MergeMarkColumns): string | null {
  if (mergeMarkKindOf(row) !== 'unmarked') return null;
  return describeMergeMark({ kind: 'unmarked' });
}

type ArtifactsRefusalCode = 'ARTIFACTS_NOT_DESIGN' | 'ARTIFACTS_ADOPTION_BY_HAND';

/**
 * The artifacts a mark records, or its refusal: on every shape the list the agent named, as named
 * (ISS-1017). On `git` a release also reads the landing commit's changed paths through the project's
 * surface map where a commit was observed or read by a box, beside these. A landing naming a design
 * revision is surface `design` whether or not the caller said so, and a non-design artifact beside it
 * is refused: a revision deploys nothing.
 */
export function markArtifacts(args: {
  landing: string | null;
  sent: readonly LandingArtifact[] | null;
}):
  | { ok: true; artifacts: LandingArtifact[] | null }
  | { ok: false; code: ArtifactsRefusalCode; detail: string } {
  const { landing, sent } = args;
  // an adoption is stamped only off the record Forge read (`adoptions`), never off a list sent by hand
  const adopted = (sent ?? []).filter((a) => a.surface === 'adoption');
  if (adopted.length > 0) {
    return {
      ok: false,
      code: 'ARTIFACTS_ADOPTION_BY_HAND',
      detail:
        `the call names \`adoption\` ${adopted.map((a) => a.ref).join(', ')} as an artifact, and an adoption is ` +
        "stamped only from the record Forge reads off the project's interface and links, so nothing was " +
        'marked. Send `adoptions: ["<project>/<contract>@<version>"]` instead.',
    };
  }
  const design = designLandingRef(landing);
  if (!design) return { ok: true, artifacts: sent ? [...sent] : null };
  const stray = (sent ?? []).filter((a) => a.surface !== 'design');
  if (stray.length > 0) {
    return {
      ok: false,
      code: 'ARTIFACTS_NOT_DESIGN',
      detail:
        `the landing names design revision ${design}, which deploys nothing, and the call names ` +
        `${stray.map((a) => `\`${a.surface}\` ${a.ref}`).join(', ')} beside it, so nothing was marked. ` +
        'Mark the design issue with the revision alone, and the work that builds it on its own issue.',
    };
  }
  return { ok: true, artifacts: sent && sent.length > 0 ? [...sent] : [designArtifact(design)] };
}

/**
 * The paths a box read sent with a mark, as the row stores them, or the refusal. They describe a
 * commit, so they belong to a project that lands in git, and to the commit the mark names.
 */
export function markReadPaths(args: {
  shape: LandingShape;
  commit: string | null;
  sent: { commit: string; changes: ReadPaths['changes'] } | null;
}):
  | { ok: true; paths: ReadPaths | null }
  | {
      ok: false;
      code: 'CHANGED_PATHS_NOT_THIS_SHAPE' | 'CHANGED_PATHS_UNMATCHED';
      detail: string;
    } {
  const { shape, commit, sent } = args;
  if (!sent) return { ok: true, paths: null };
  if (shape !== 'git') {
    return {
      ok: false,
      code: 'CHANGED_PATHS_NOT_THIS_SHAPE',
      detail:
        "`changedPaths` are a commit's changed files, and this project's work lands outside git, so " +
        'nothing was marked. Name what landed with `artifacts` beside `landing` instead.',
    };
  }
  const read = sent.commit.toLowerCase();
  const named = (commit ?? '').toLowerCase();
  if (!named || !(read.startsWith(named) || named.startsWith(read))) {
    return {
      ok: false,
      code: 'CHANGED_PATHS_UNMATCHED',
      detail: `\`changedPaths\` were read at ${sent.commit}, and the mark names ${commit ? `commit ${commit}` : 'no commit'}, so nothing was marked. Send them with the \`commit\` they were read at.`,
    };
  }
  return { ok: true, paths: { commit: sent.commit, read: 'box', changes: sent.changes } };
}

/** Artifacts the stamp did not record because a mark already stands, or `null` where it did. */
export function standingArtifactsRefusal(args: {
  sent: readonly LandingArtifact[] | null;
  wrote: boolean;
  held: readonly LandingArtifact[] | null;
}): { code: 'MARK_ALREADY_STANDS'; detail: string } | null {
  if (!args.sent || args.wrote) return null;
  if (JSON.stringify(args.held ?? null) === JSON.stringify(args.sent)) return null;
  const stands = args.held
    ? `this issue's mark already names ${args.held.length} artifact(s)`
    : "this issue's mark already stands and names no artifact";
  return {
    code: 'MARK_ALREADY_STANDS',
    detail:
      `${stands}, and the first mark stands, so the artifacts sent were not recorded and nothing ` +
      `changed. To change them, ${CLEAR_THE_MARK}, then mark again with the landing and artifacts ` +
      'that are right.',
  };
}

/** A landing the stamp did not record because a mark already stands, or `null` where it did.
 *  The first stamp wins for the landing as for `merged_at`, so a correction is refused by name
 *  rather than answered as a success that dropped it: docs/modules/issues/merge-mark.md. */
export function standingMarkRefusal(args: {
  sent: string | null;
  wrote: boolean;
  held: MergeMarkColumns;
}): { code: 'MARK_ALREADY_STANDS'; detail: string } | null {
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
      `changed. To change it, ${CLEAR_THE_MARK}, then mark again with the landing that is right.`,
  };
}

type ShapeExecutor = Pick<Db, 'select'>;

const sourceTypeOf = sql<string | null>`${projectConfigDocuments.document} -> 'source' ->> 'type'`;

export async function readLandingShape(
  projectId: string,
  executor: ShapeExecutor = db,
): Promise<LandingShape | null> {
  const [row] = await executor
    .select({ sourceType: sourceTypeOf })
    .from(projectConfigDocuments)
    .where(eq(projectConfigDocuments.projectId, projectId))
    .limit(1);
  return landingShapeOf(row?.sourceType ?? null);
}
