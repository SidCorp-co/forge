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
 * on a build where it was judged at that commit or at one holding it, read by the project's ancestry
 * reader (`shipped-earlier.ts:ancestrySourceFor`). One at an earlier commit, such as the branch's
 * head before the merge, never counts, whatever the branch holds now.
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
import { type AncestryPair, pairKey } from '../runners/index.js';
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
    basis: `${build.basis}; this project declares no production environment, so its landing is the build a verdict counts on, judged there or at a commit holding it`,
  };
}

/** The pair whose answer says a judgement at `judged` holds `build`. */
export function holdingPair(build: string, judged: string): AncestryPair {
  return { commit: build.toLowerCase(), release: judged.toLowerCase() };
}

/** Whether each judgement holds its build, through the project's ancestry reader. */
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
      why: `it was judged against ${at.kind} \`${at.value}\`, not a commit, and with no production environment only a commit holding the landing counts`,
    };
  }
  const sha = at.value.trim().toLowerCase();
  return WHOLE.test(sha)
    ? { sha }
    : { why: `it was judged at \`${at.value}\`, which is not a whole commit` };
}

/** The pair each verdict on `criteria` is weighed by, where it names a whole commit. */
export function criteriaPairs(
  build: string,
  criteria: readonly StandingCriterion[],
): AncestryPair[] {
  return criteria.flatMap(({ verdict }) => {
    const judged = verdict ? judgedCommit(verdict) : null;
    return judged && 'sha' in judged ? [holdingPair(build, judged.sha)] : [];
  });
}

/**
 * One criterion's standing on `build`: a pass or short the verified rule counts, judged at `build`
 * or at a commit holding it. Every other answer says what it lacks and the shape that would count.
 */
export function weighOnLanded(
  build: string,
  { criterion, verdict }: StandingCriterion,
  holding: ReadonlyMap<string, Holding>,
): LandedCriterion {
  const owed = `a \`pass\` judged at \`${short(build)}\` or a commit holding it`;
  const no = (why: string): LandedCriterion => ({
    criterion,
    counts: false,
    why: `${why}; it needs ${owed}`,
  });
  if (!verdict) return no('no verdict was recorded for it');
  if (verdict.unverified) return no(verdict.unverified);
  if (!verdictEarns(verdict.verdict)) return no(`its verdict is \`${verdict.verdict}\``);
  const judged = judgedCommit(verdict);
  if ('why' in judged) return no(judged.why);
  const held = holding.get(pairKey(holdingPair(build, judged.sha)));
  if (held === true) return { criterion, counts: true, at: judged.sha };
  if (held === false) {
    return no(`it was judged at \`${short(judged.sha)}\`, which does not hold \`${short(build)}\``);
  }
  return no(
    `whether \`${short(judged.sha)}\`, where it was judged, holds \`${short(build)}\` could not be read: ${held?.unread ?? 'it was not asked'}`,
  );
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
  projectId: string,
  issueIds: readonly string[],
  buildOf: (issueId: string) => string,
  deps?: Pick<JudgedBuildDeps, 'ancestry'>,
): Promise<LandedStanding[]> {
  const standing = await standingCriteriaOf(issueIds);
  const pairs = [...standing].flatMap(([id, s]) => criteriaPairs(buildOf(id), s.criteria));
  const holding = pairs.length > 0 ? await readHolding(projectId, pairs, deps) : new Map();
  return issueIds.flatMap((issueId) => {
    const s = standing.get(issueId);
    if (!s) return [];
    const build = buildOf(issueId);
    return [
      {
        issueId,
        owes: s.owes,
        criteria: s.owes ? s.criteria.map((c) => weighOnLanded(build, c, holding)) : [],
      },
    ];
  });
}

/**
 * Why the steward's output check may not send this issue back, or null where it may: under release
 * mode `none`, an issue at the gate whose landing is recorded and whose every live criterion stands on
 * a counting pass at that landing is missing nothing, since the landing is its running build.
 */
export async function landedReopenRefusal(
  issueId: string,
  deps?: Pick<JudgedBuildDeps, 'ancestry'>,
): Promise<string | null> {
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
  const [standing] = await landedStandings(row.projectId, [issueId], () => sha, deps);
  if (!standing?.owes || standing.criteria.length === 0) return null;
  const counted = standing.criteria.flatMap((c) => (c.counts ? [c] : []));
  if (counted.length < standing.criteria.length) return null;
  const at = counted.map((c) => `criterion ${c.criterion} at \`${short(c.at)}\``).join(', ');
  return `${build.basis}, and every live criterion stands on a pass judged there or at a commit holding it (${at}). This project declares no production environment, so that landing is the running build and no evidence is missing: wake the master to record the landing (POST /api/projects/${row.projectId}/release-records) instead of sending it back.`;
}

/** Per issue, the landed build its verdicts count on, and what each verdict commit holds of it. */
export interface LandedHolds {
  sha: string | null;
  /** Why the issue has no landed build; null where it has one. */
  why: string | null;
  /** Per verdict commit, lower case, whether it holds `sha`. */
  holds: Map<string, boolean>;
  /** Per verdict commit nobody could weigh, why. */
  unanswered: Map<string, string>;
}

/**
 * A requirement's coverage reading on a project with no production environment
 * (`requirements/standing-coverage.ts`): each verdict commit weighed on its own issue's landed build
 * rather than on a production probe that cannot exist. Null on a project with production, whose
 * coverage reads the live build (`judged-build.ts:liveBuildHolds`).
 */
export async function landedBuildHolds(
  projectId: string,
  judged: ReadonlyArray<{ issueId: string; commit: string }>,
  deps?: Pick<JudgedBuildDeps, 'ancestry'>,
): Promise<{
  sha: null;
  holds: Map<string, boolean>;
  runtimes: Map<string, string | null>;
  unanswered: Map<string, string>;
  landed: Map<string, LandedHolds>;
} | null> {
  if (!(await landsAsDelivery(projectId))) return null;
  const asked = judged.map((j) => ({
    issueId: j.issueId.toLowerCase(),
    commit: j.commit.trim().toLowerCase(),
  }));
  const builds = await landedBuildsOf([...new Set(asked.map((j) => j.issueId))]);
  const pairs = asked.flatMap((j) => {
    const sha = builds.get(j.issueId)?.sha;
    return sha ? [holdingPair(sha, j.commit)] : [];
  });
  const holding =
    pairs.length > 0 ? await readHolding(projectId, pairs, deps) : new Map<string, Holding>();
  const landed = new Map<string, LandedHolds>();
  for (const [issueId, build] of builds) {
    landed.set(issueId, {
      sha: build.sha,
      why: build.sha === null ? build.why : null,
      holds: new Map(),
      unanswered: new Map(),
    });
  }
  for (const j of asked) {
    const entry = landed.get(j.issueId);
    if (!entry?.sha) continue;
    const held = holding.get(pairKey(holdingPair(entry.sha, j.commit)));
    if (typeof held === 'boolean') entry.holds.set(j.commit, held);
    else entry.unanswered.set(j.commit, held?.unread ?? 'the ancestry reader gave no answer');
  }
  return { sha: null, holds: new Map(), runtimes: new Map(), unanswered: new Map(), landed };
}
