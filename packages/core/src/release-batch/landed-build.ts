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
 * build, and counts only on a record made at that head. Before that record, the steward and coverage
 * read such a head as the build where every live criterion passes there (`aheadBuildsOf`).
 *
 * A project that releases by merging its change requests has no production either, and its build is
 * read by the same doors through `deliveredBuildsOf`: the unchanged head of the open request linked
 * to the issue until the host merges it, then the host's merge commit (`change-request-build.ts`).
 */

import { releaseThroughChangeRequests } from '@forge/contracts/releases';
import {
  type JudgedBuild,
  landedIdentityWhy,
  verdictEarns,
} from '@forge/contracts/verdict-identity';
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
import { readProjectDocument } from '../project-config/index.js';
import { type AncestryPair, pairKey } from '../runners/index.js';
import { changeRequestBuildsOf, otherHeadWhy } from './change-request-build.js';
import { RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import { resolveReleaseDeclaration } from './gate.js';
import { ancestryOf, type JudgedBuildDeps } from './judged-build.js';

const WHOLE = /^[0-9a-f]{40}$/;

/** What a landing release records as its verification: no deployment, the landing itself. */
export const LANDED_VERIFICATION = 'landed';

export type LandedBuild =
  | {
      sha: string;
      from: 'record' | 'merge' | 'mark' | 'ahead' | 'change-request';
      basis: string;
      /** The change request whose head this is (`!12`), which a verdict elsewhere is weighed against. */
      via?: string | null;
    }
  | { sha: null; why: string };

/**
 * How a project with no production environment delivers: by its landing on the branch its document
 * declares (release mode `none`), or by merging its change requests once a release is approved
 * (REQ-63, `change-request-build.ts`). Null on a project with production, with no document, or whose
 * work lands outside git, which names no commit a delivery is and is read as before.
 */
export type Delivery = 'landing' | 'change-request';

export async function deliveryOf(projectId: string): Promise<Delivery | null> {
  const declared = await resolveReleaseDeclaration(projectId);
  if (declared?.kind === 'change-requests') return 'change-request';
  return declared?.kind === 'no-release' && declared.defaultBranch !== null ? 'landing' : null;
}

/** Whether this project's landing is its delivery (release mode `none`). */
export async function landsAsDelivery(projectId: string): Promise<boolean> {
  return (await deliveryOf(projectId)) === 'landing';
}

/**
 * The one reading of the build each issue's verdicts count on where the project has no production:
 * its landing, or a later head holding it (`aheadBuildsOf`; `ahead: false` reads the landing alone),
 * or, on a change-request project, its request's unchanged head or host merge commit.
 */
export async function deliveredBuildsOf(
  projectId: string,
  delivery: Delivery,
  issueIds: readonly string[],
  opts: { ahead: boolean } = { ahead: true },
): Promise<Map<string, LandedBuild>> {
  if (delivery === 'landing') {
    const landed = await landedBuildsOf(issueIds);
    return opts.ahead ? aheadBuildsOf(projectId, landed) : landed;
  }
  return changeRequestBuildsOf(projectId, issueIds);
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

/** An issue's head as every reader names it on a change-request project, or why it has none. */
export interface DeliveryHead {
  sha: string | null;
  branch: string | null;
  basis: string;
}

/**
 * The head of each issue on a change-request project, through the same reading its verdicts count
 * on (`deliveredBuildsOf`): the head of the open request linked to it, else its host merge commit.
 * A run's worklog capture of its work branch is never the issue's head there. Null on any other
 * project, where the work state's branch and head are the run's own record.
 */
export async function deliveryHeadsOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, DeliveryHead> | null> {
  // `release.changeRequests` is refused beside a production environment
  // (`project-config/change-request-rule.ts`), so the document alone says this project delivers
  // through change requests, read once a request (`deliveryOf` reads the whole release path)
  if (!releaseThroughChangeRequests((await readProjectDocument(projectId))?.document)) return null;
  const out = new Map<string, DeliveryHead>();
  for (const [id, b] of await changeRequestBuildsOf(projectId, issueIds)) {
    out.set(
      id,
      b.sha === null
        ? { sha: null, branch: null, basis: b.why }
        : { sha: b.sha, branch: b.branch, basis: b.basis },
    );
  }
  return out;
}

/** The build a verdict on an issue defaults to where its project has no production; null elsewhere. */
export async function landedJudgedBuild(issue: {
  id: string;
  projectId: string;
}): Promise<JudgedBuild | null> {
  const delivery = await deliveryOf(issue.projectId);
  if (!delivery) return null;
  const build = (
    await deliveredBuildsOf(issue.projectId, delivery, [issue.id], { ahead: false })
  ).get(issue.id.toLowerCase());
  if (!build) return { sha: null, source: null, version: null, basis: 'the issue was not found' };
  if (build.sha === null) return { sha: null, source: null, version: null, basis: build.why };
  if (delivery === 'change-request') {
    return {
      sha: build.sha,
      source: build.from === 'merge' ? 'merged' : 'change-request',
      version: null,
      basis: `${build.basis}; this project releases by merging its change requests, so that is the build a verdict counts on, judged at that commit`,
    };
  }
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
  const misshapen = landedIdentityWhy(at.kind === 'source' ? 'commit' : at.kind, at.value);
  if (misshapen) return { why: `it was ${misshapen}` };
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
  via: string | null = null,
): LandedCriterion {
  const no = (why: string): LandedCriterion => ({
    criterion,
    counts: false,
    why: `${why}; it needs a \`pass\` whose identity is commit \`${short(build)}\``,
  });
  if (!verdict) return no('no verdict was recorded for it');
  if (verdict.unverified) return no(verdict.unverified);
  if (!verdictEarns(verdict.verdict)) return no(`its verdict is \`${verdict.verdict}\``);
  const judged = judgedCommit(verdict);
  if ('why' in judged) return no(judged.why);
  if (judged.sha !== build.toLowerCase()) {
    return no(via ? otherHeadWhy(judged.sha, build, via) : otherBuildWhy(judged.sha, build));
  }
  return { criterion, counts: true, at: judged.sha };
}

// Where the project's document owes no verdict, a criterion with none is not weighed, and QA may
// judge it after the landing; a verdict that is there is kernel input all the same, and one whose
// identity names no commit is refused by name rather than closed over (`landedIdentityWhy`).
function misshapenOf(build: string, criteria: readonly StandingCriterion[]): LandedCriterion[] {
  return criteria.flatMap(({ criterion, verdict }) => {
    if (!verdict?.at || verdict.at.kind === 'source') return [];
    const why = landedIdentityWhy(verdict.at.kind, verdict.at.value);
    return why
      ? [
          {
            criterion,
            counts: false as const,
            why: `it was ${why}; it needs a verdict whose identity is commit \`${short(build)}\``,
          },
        ]
      : [];
  });
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
  viaOf: (issueId: string) => string | null = () => null,
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
        criteria: s.owes
          ? s.criteria.map((c) => weighOnLanded(build, c, viaOf(issueId)))
          : misshapenOf(build, s.criteria),
      },
    ];
  });
}

/**
 * Before a record, the build each issue will be recorded at, as the steward and coverage read it.
 * Where every live criterion of an issue not yet recorded stands on a counting pass at one commit,
 * and that commit contains the landing its merge names (read through the same ancestry reader the
 * record uses), that commit is the build: the record a master makes there will count every one of
 * them. A pass split across commits, or at a commit not containing the landing, leaves the landing
 * as it was. A recorded landing is never moved.
 */
export async function aheadBuildsOf(
  projectId: string,
  builds: ReadonlyMap<string, LandedBuild>,
): Promise<Map<string, LandedBuild>> {
  const out = new Map(builds);
  const open = [...builds].filter(([, b]) => b.sha !== null && b.from !== 'record');
  if (open.length === 0) return out;
  const standing = await standingCriteriaOf(open.map(([id]) => id));
  const ahead = new Map<string, { landing: string; sha: string }>();
  for (const [issueId, build] of open) {
    const s = standing.get(issueId);
    if (!s?.owes || s.criteria.length === 0 || build.sha === null) continue;
    const at = s.criteria.map(({ verdict }) => {
      if (!verdict || verdict.unverified || !verdictEarns(verdict.verdict)) return null;
      const judged = judgedCommit(verdict);
      return 'sha' in judged ? judged.sha : null;
    });
    const one = at[0];
    if (!one || one === build.sha || at.some((sha) => sha !== one)) continue;
    ahead.set(issueId, { landing: build.sha, sha: one });
  }
  if (ahead.size === 0) return out;
  const held = await readHolding(
    projectId,
    [...ahead.values()].map((a) => holdingPair(a.landing, a.sha)),
  );
  for (const [issueId, { landing, sha }] of ahead) {
    if (held.get(pairKey(holdingPair(landing, sha))) !== true) continue;
    out.set(issueId, {
      sha,
      from: 'ahead',
      basis: `every live criterion passes at \`${short(sha)}\`, which contains the landing its merge names (\`${short(landing)}\`), so a landing recorded at \`${short(sha)}\` counts them`,
    });
  }
  return out;
}

/** The live criteria the issue's design plans a proof for, by number. */
async function proofPlanned(issueId: string): Promise<number[]> {
  const rows = (await db.execute(sql`
    SELECT c.n FROM issue_design_criteria d
      JOIN issue_criteria c ON c.id = d.criterion_id AND c.retired_at IS NULL
     WHERE d.issue_id = ${issueId}::uuid
     ORDER BY c.n
  `)) as unknown as Array<{ n: number }>;
  return rows.map((r) => Number(r.n));
}

/**
 * Why the steward's output check may not send this issue back, or null where it may. Under release
 * mode `none` both of its reasons read the landed build: a verdict counts on the running build where
 * it was judged at the landed commit, and since no release run replays a probe there, the design's
 * proof plan is met where each criterion it plans to prove has that pass. So an issue at the gate
 * whose landing is recorded and whose every live criterion, every planned one among them, passes at
 * that commit is missing nothing.
 */
export async function landedReopenRefusal(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: issues.projectId, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (row?.status !== 'awaiting_release') return null;
  const delivery = await deliveryOf(row.projectId);
  if (!delivery) return null;
  const build = (await deliveredBuildsOf(row.projectId, delivery, [issueId])).get(
    issueId.toLowerCase(),
  );
  if (!build?.sha) return null;
  const sha = build.sha;
  const [standing] = await landedStandings(
    [issueId],
    () => sha,
    () => build.via ?? null,
  );
  if (!standing?.owes || standing.criteria.length === 0) return null;
  if (standing.criteria.some((c) => !c.counts)) return null;
  const counted = new Set(standing.criteria.map((c) => c.criterion));
  const planned = await proofPlanned(issueId);
  if (planned.some((n) => !counted.has(n))) return null;
  const plan =
    planned.length > 0
      ? ` The design's proof plan is met the same way: each of the ${planned.length} criteria it plans to prove passes at that commit, and with no production environment no release run replays a probe.`
      : '';
  if (delivery === 'change-request') {
    return `${build.basis}, and every live criterion (${[...counted].join(', ')}) stands on a pass judged at that commit. This project releases by merging its change requests, with no production environment: until the request merges its unchanged head is the build its verdicts are read on, and no landing record is owed (REQ-63 BC-6).${plan} No evidence is missing: wake the master to cut the release that merges it (POST /api/projects/${row.projectId}/release-batches) instead of sending it back.`;
  }
  return `${build.basis}, and every live criterion (${[...counted].join(', ')}) stands on a pass judged at that commit. This project declares no production environment, so that landing is the running build and its verdicts are read there.${plan} No evidence is missing: wake the master to record the landing (POST /api/projects/${row.projectId}/release-records) instead of sending it back.`;
}

/** One issue's landed build, or why it has none. */
export interface LandedHolds {
  sha: string | null;
  /** Why the issue has no landed build; null where it has one. */
  why: string | null;
}

/**
 * A requirement's coverage reading on a project with no production environment
 * (`requirements/standing-coverage.ts`): each issue's landed build (on a change-request project,
 * its request's unchanged head or host merge commit), which a verdict counts on only
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
  const delivery = await deliveryOf(projectId);
  if (!delivery) return null;
  const ids = [...new Set(issueIds.map((id) => id.toLowerCase()))];
  const builds = await deliveredBuildsOf(projectId, delivery, ids);
  const landed = new Map<string, LandedHolds>();
  for (const [issueId, build] of builds) {
    landed.set(issueId, { sha: build.sha, why: build.sha === null ? build.why : null });
  }
  return { sha: null, holds: new Map(), runtimes: new Map(), unanswered: new Map(), landed };
}
