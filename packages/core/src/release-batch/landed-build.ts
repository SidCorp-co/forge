/**
 * What counts as the running build of an issue under release mode `none`, where the project declares
 * no production environment. Landing on the project's working branch IS the delivery there (owner
 * ruling 2026-10-22), so the build its verdicts count on is the landing, never a production probe
 * that cannot exist. One definition, read by the record that closes the issue (`recorded.ts`), a
 * requirement's coverage (`requirements/standing-coverage.ts`), the steward's output check
 * (`steward/door-writes.ts`) and the build a verdict defaults to (`judged-build.ts`).
 *
 * The landed build is, first found: the commit the landing record that closed the issue names; the
 * merge commit Forge observed (`merged_commit_sha`); the commit the current merge mark claims
 * (`issues/mark-trail.ts`). None of them is no landed build, named, never a guess. A judgement counts
 * on it only where it was judged at that very commit. One at an earlier commit judged another build,
 * even a branch head before the merge whose tree is the same; one at a later head judged a newer
 * build, and counts only on a record made at that head.
 */

import { type JudgedBuild, verdictEarns } from '@forge/contracts/verdict-identity';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  type CriterionVerdict,
  currentMarkClaims,
  issueDisplayIds,
  type StandingCriterion,
  standingCriteriaOf,
} from '../issues/index.js';
import type { AncestryPair } from '../runners/index.js';
import { RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import { resolveReleaseDeclaration } from './gate.js';
import { ancestryOf, type JudgedBuildDeps } from './judged-build.js';

const WHOLE = /^[0-9a-f]{40}$/;

/** What a landing release records as its verification: no deployment, the landing itself. */
export const LANDED_VERIFICATION = 'landed';

export type LandedBuild =
  | { sha: string; from: 'record' | 'merge' | 'mark'; basis: string }
  | { sha: null; why: string };

/**
 * Whether this project's landing is its delivery: its document declares a branch work lands on and
 * no production environment (release mode `none`). A project with no document, or whose work lands
 * outside git, names no commit a landing is, and is read as before.
 */
export async function landsAsDelivery(projectId: string): Promise<boolean> {
  const declared = await resolveReleaseDeclaration(projectId);
  return declared?.kind === 'no-release' && declared.defaultBranch !== null;
}

/** Whether a judgement at a commit holds a build, or why that could not be read. */
export type Holding = boolean | { unread: string };

const short = (sha: string) => sha.slice(0, 12);

/** The commit the landing record that closed each issue names, for the issues standing closed. */
async function recordedLandings(ids: readonly string[]): Promise<Map<string, string>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (i.id) i.id::text AS id, r.metadata ->> 'commit' AS commit
      FROM issues i
      JOIN pipeline_runs r
        ON r.project_id = i.project_id
       AND r.metadata ->> 'source' = ${RELEASE_RECORD_SOURCE}
       AND r.metadata ->> 'verification' = ${LANDED_VERIFICATION}
       AND r.metadata -> 'issueIds' ? (i.id::text)
     WHERE i.id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND i.status = 'closed'
     ORDER BY i.id, r.started_at DESC
  `)) as unknown as Array<{ id: string; commit: string | null }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    const commit = r.commit?.trim().toLowerCase() ?? '';
    if (WHOLE.test(commit)) out.set(r.id, commit);
  }
  return out;
}

/** Each issue's landed build, or why it has none. */
export async function landedBuildsOf(
  issueIds: readonly string[],
): Promise<Map<string, LandedBuild>> {
  const out = new Map<string, LandedBuild>();
  const ids = [...new Set(issueIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: issues.id, mergedAt: issues.mergedAt, sha: issues.mergedCommitSha })
    .from(issues)
    .where(inArray(issues.id, ids));
  const [recorded, claims, shown] = await Promise.all([
    recordedLandings(ids),
    currentMarkClaims(ids),
    issueDisplayIds(ids),
  ]);
  for (const row of rows) {
    const key = shown.get(row.id) ?? row.id;
    const record = recorded.get(row.id);
    const merged = row.sha?.trim().toLowerCase() ?? '';
    const claimed = claims.get(row.id);
    if (record) {
      out.set(row.id, {
        sha: record,
        from: 'record',
        basis: `${key} was closed by a landing record at \`${short(record)}\``,
      });
    } else if (WHOLE.test(merged)) {
      out.set(row.id, {
        sha: merged,
        from: 'merge',
        basis: `${key} merged as \`${short(merged)}\`, which Forge observed`,
      });
    } else if (claimed) {
      out.set(row.id, {
        sha: claimed,
        from: 'mark',
        basis: `${key}'s merge mark names \`${short(claimed)}\``,
      });
    } else {
      out.set(row.id, {
        sha: null,
        why:
          row.mergedAt === null
            ? `${key} has not merged, so nothing has landed for a verdict to count on`
            : `${key}'s merge records no commit, so nothing says which build it landed as: mark it again naming the commit it landed at (\`DELETE\`, then \`POST /api/issues/${row.id}/merge\` with \`target\` and \`commit\`)`,
      });
    }
  }
  return out;
}

/** The build a verdict on an issue defaults to where its project has no production; null elsewhere. */
export async function landedJudgedBuild(issue: {
  id: string;
  projectId: string;
}): Promise<JudgedBuild | null> {
  if (!(await landsAsDelivery(issue.projectId))) return null;
  const build = (await landedBuildsOf([issue.id])).get(issue.id.toLowerCase());
  if (!build) return { sha: null, source: null, version: null, basis: 'the issue was not found' };
  if (build.sha === null) return { sha: null, source: null, version: null, basis: build.why };
  return {
    sha: build.sha,
    source: 'landed',
    version: null,
    basis: `${build.basis}; this project declares no production environment, so its landing is the build a verdict counts on, judged at that commit`,
  };
}

/** The pair whose answer says `build` is `commit` or an ancestor of it. */
export function holdingPair(build: string, commit: string): AncestryPair {
  return { commit: build.toLowerCase(), release: commit.toLowerCase() };
}

/** Whether each pair's build is in its commit, through the project's ancestry reader. */
export async function readHolding(
  projectId: string,
  pairs: readonly AncestryPair[],
  deps?: Pick<JudgedBuildDeps, 'ancestry'>,
): Promise<Map<string, Holding>> {
  return ancestryOf(projectId, pairs, deps);
}

/** One live criterion weighed on a landed build: it counts, or why it does not. */
export type LandedCriterion =
  | { criterion: number; counts: true; at: string }
  | { criterion: number; counts: false; why: string };

/** The whole commit a verdict was judged at, or why it names none. */
function judgedCommit(verdict: CriterionVerdict): { sha: string } | { why: string } {
  const at = verdict.at;
  if (!at) return { why: 'it names nothing it was judged against' };
  if (at.kind !== 'source') {
    return {
      why: `it was judged against ${at.kind} \`${at.value}\`, not a commit, and with no production environment only a verdict at the landed commit counts`,
    };
  }
  const sha = at.value.trim().toLowerCase();
  return WHOLE.test(sha)
    ? { sha }
    : { why: `it was judged at \`${at.value}\`, which is not a whole commit` };
}

/** Why a verdict at `judged` does not count on `build`, naming both commits. */
export function otherBuildWhy(judged: string, build: string): string {
  return `it was judged at \`${short(judged)}\`, not at \`${short(build)}\`: a verdict at an earlier commit judged another build, and one at a later head counts only on a record made at that head`;
}

/**
 * One criterion's standing on `build`: a pass or short the verified rule counts, judged at `build`
 * itself. Every other answer says what it lacks, where its verdict sits and the commit it needed.
 */
export function weighOnLanded(
  build: string,
  { criterion, verdict }: StandingCriterion,
): LandedCriterion {
  const no = (why: string): LandedCriterion => ({
    criterion,
    counts: false,
    why: `${why}; it needs a \`pass\` judged at \`${short(build)}\``,
  });
  if (!verdict) return no('no verdict was recorded for it');
  if (verdict.unverified) return no(verdict.unverified);
  if (!verdictEarns(verdict.verdict)) return no(`its verdict is \`${verdict.verdict}\``);
  const judged = judgedCommit(verdict);
  if ('why' in judged) return no(judged.why);
  if (judged.sha !== build.toLowerCase()) return no(otherBuildWhy(judged.sha, build));
  return { criterion, counts: true, at: judged.sha };
}

/** Each issue's live criteria weighed on the build `buildOf` names for it. */
export interface LandedStanding {
  issueId: string;
  /** False where the project's document says its issues owe no verdict. */
  owes: boolean;
  criteria: LandedCriterion[];
}

/** Every live criterion of `issueIds` weighed on the build `buildOf` names for its issue. */
export async function landedStandings(
  issueIds: readonly string[],
  buildOf: (issueId: string) => string,
): Promise<LandedStanding[]> {
  const standing = await standingCriteriaOf(issueIds);
  return issueIds.flatMap((issueId) => {
    const s = standing.get(issueId);
    if (!s) return [];
    const build = buildOf(issueId);
    return [
      {
        issueId,
        owes: s.owes,
        criteria: s.owes ? s.criteria.map((c) => weighOnLanded(build, c)) : [],
      },
    ];
  });
}

/**
 * Why the steward's output check may not send this issue back, or null where it may: under release
 * mode `none`, an issue at the gate whose landing is recorded and whose every live criterion stands on
 * a pass at that landed commit is missing nothing, since the landing is its running build.
 */
export async function landedReopenRefusal(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: issues.projectId, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (row?.status !== 'awaiting_release') return null;
  if (!(await landsAsDelivery(row.projectId))) return null;
  const build = (await landedBuildsOf([issueId])).get(issueId.toLowerCase());
  if (!build?.sha) return null;
  const sha = build.sha;
  const [standing] = await landedStandings([issueId], () => sha);
  if (!standing?.owes || standing.criteria.length === 0) return null;
  if (standing.criteria.some((c) => !c.counts)) return null;
  const numbers = standing.criteria.map((c) => c.criterion).join(', ');
  return `${build.basis}, and every live criterion (${numbers}) stands on a pass judged at that commit. This project declares no production environment, so that landing is the running build and no evidence is missing: wake the master to record the landing (POST /api/projects/${row.projectId}/release-records) instead of sending it back.`;
}

/** One issue's landed build, or why it has none. */
export interface LandedHolds {
  sha: string | null;
  /** Why the issue has no landed build; null where it has one. */
  why: string | null;
}

/**
 * A requirement's coverage reading on a project with no production environment
 * (`requirements/standing-coverage.ts`): each issue's landed build, which a verdict counts on only
 * where it was judged at that commit, rather than a production probe that cannot exist. Null on a
 * project with production, whose coverage reads the live build (`judged-build.ts:liveBuildHolds`).
 */
export async function landedBuildHolds(
  projectId: string,
  issueIds: readonly string[],
): Promise<{
  sha: null;
  holds: Map<string, boolean>;
  runtimes: Map<string, string | null>;
  unanswered: Map<string, string>;
  landed: Map<string, LandedHolds>;
} | null> {
  if (!(await landsAsDelivery(projectId))) return null;
  const builds = await landedBuildsOf([...new Set(issueIds.map((id) => id.toLowerCase()))]);
  const landed = new Map<string, LandedHolds>();
  for (const [issueId, build] of builds) {
    landed.set(issueId, { sha: build.sha, why: build.sha === null ? build.why : null });
  }
  return { sha: null, holds: new Map(), runtimes: new Map(), unanswered: new Map(), landed };
}
