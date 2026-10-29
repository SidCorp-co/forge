/**
 * What counts as the running build of an issue under release mode `none`, where the project declares
 * no production environment. Landing on the project's working branch IS the delivery there (owner
 * ruling 2026-10-22), so the build its verdicts count on is the landing, never a production probe
 * that cannot exist. One definition, read by the record that closes the issue (`recorded.ts`), a
 * requirement's coverage (`requirements/standing-coverage.ts`), the steward's release facts
 * (`landed-facts.ts`) and the build a verdict defaults to (`judged-build.ts`).
 *
 * The landed build is, first found: the merge commit Forge observed (`merged_commit_sha`) where it
 * was stamped after the landing record that closed the issue (a host merge supersedes a landing
 * recorded in an earlier era: adminhub-api ISS-15, 2026-10-26), else that record's commit; the
 * observed merge commit; the commit the current merge mark claims (`issues/mark-trail.ts`). None of
 * them is no landed build, named, never a guess. A judgement counts on it only where it was judged at
 * that very commit, or at the head of the request that merged as it where Forge read from the host,
 * at the merge, that the two trees are identical (`issues.merged_head`, `atMergedHead`). One at any
 * other earlier commit judged another build; one at a later head judged a newer build, and counts
 * only on a record made at that head. Before that record, the steward and coverage read such a head
 * as the build where every live criterion passes there (`aheadBuildsOf`). A requirement's coverage
 * also counts a pass at any later build that holds the landing (`landed-build-holds.ts:landedBuildHolds`, REQ-36 BC-18),
 * which is the build the testing environment serves; a record keeps this file's rule.
 *
 * A project that releases by merging its change requests has no production either, and its build is
 * read by the same doors through `deliveredBuildsOf`: the unchanged head of the open request linked
 * to the issue until the host merges it, then the host's merge commit (`change-request-build.ts`).
 */

import type { MergedHead } from '@forge/contracts/landing-artifacts';
import { releaseThroughChangeRequests } from '@forge/contracts/releases';
import {
  type JudgedBuild,
  landedCommitOf,
  landedIdentityWhy,
  verdictEarns,
} from '@forge/contracts/verdict-identity';
import { inArray, sql } from 'drizzle-orm';
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
import type { JudgedAgainst } from './landed-build-holds.js';
import { recordedHolding } from './recorded-holding.js';

const WHOLE = /^[0-9a-f]{40}$/;

/** What a landing release records as its verification: no deployment, the landing itself. */
export const LANDED_VERIFICATION = 'landed';

export type LandedBuild =
  | {
      sha: string;
      from: 'record' | 'merge' | 'mark' | 'ahead' | 'change-request' | 'landed';
      basis: string;
      /** The change request whose head this is (`!12`), which a verdict elsewhere is weighed against. */
      via?: string | null;
      /** Where this is a host merge commit: the request's head and whether its tree is this one's. */
      head?: MergedHead | null;
    }
  | {
      sha: null;
      why: string;
      /** The host could not be read, so whether the work is on the target branch is unknown. */
      unread?: true;
    };

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
  const builds: Map<string, LandedBuild> = await changeRequestBuildsOf(projectId, issueIds);
  // work already on the target branch with no request is a landing, read as one (`landed-on-target.ts`)
  const landed = new Map([...builds].filter(([, b]) => b.sha !== null && b.from === 'landed'));
  if (!opts.ahead || landed.size === 0) return builds;
  for (const [id, b] of await aheadBuildsOf(projectId, landed)) builds.set(id, b);
  return builds;
}

/** Whether a judgement at a commit holds a build, or why that could not be read. */
export type Holding = boolean | { unread: string };

const short = (sha: string) => sha.slice(0, 12);

/** The commit the landing record that closed each issue names and when, for the issues standing closed. */
async function recordedLandings(
  ids: readonly string[],
): Promise<Map<string, { commit: string; at: Date }>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (i.id) i.id::text AS id, r.metadata ->> 'commit' AS commit,
           r.started_at AS at
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
  `)) as unknown as Array<{ id: string; commit: string | null; at: Date | string }>;
  const out = new Map<string, { commit: string; at: Date }>();
  for (const r of rows) {
    const commit = r.commit?.trim().toLowerCase() ?? '';
    if (WHOLE.test(commit)) out.set(r.id, { commit, at: new Date(r.at) });
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
    .select({
      id: issues.id,
      mergedAt: issues.mergedAt,
      sha: issues.mergedCommitSha,
      head: issues.mergedHead,
    })
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
    const observed = WHOLE.test(merged);
    // a merge Forge observed after the record supersedes it: the record named an earlier landing
    const superseded =
      record !== undefined &&
      observed &&
      merged !== record.commit &&
      row.mergedAt !== null &&
      row.mergedAt.getTime() > record.at.getTime();
    if (record && !superseded) {
      out.set(row.id, {
        sha: record.commit,
        from: 'record',
        basis: `${key} was closed by a landing record at \`${short(record.commit)}\``,
      });
    } else if (observed) {
      out.set(row.id, {
        sha: merged,
        from: 'merge',
        basis: record
          ? `${key} merged as \`${short(merged)}\`, which Forge observed after the landing record at \`${short(record.commit)}\` and which supersedes it`
          : `${key} merged as \`${short(merged)}\`, which Forge observed`,
        head: row.head ?? null,
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
      source: build.from === 'merge' || build.from === 'landed' ? 'merged' : 'change-request',
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

/** Per issue, what each of its live criteria's verdicts was judged against, as `laterHoldersOf` reads it. */
function judgedAgainstOf(
  standing: ReadonlyMap<string, { criteria: readonly StandingCriterion[] }>,
): Map<string, JudgedAgainst[]> {
  const out = new Map<string, JudgedAgainst[]>();
  for (const [issueId, s] of standing) {
    const against = s.criteria.flatMap(({ verdict }) =>
      verdict?.at
        ? [
            {
              kind: verdict.at.kind === 'source' ? 'commit' : verdict.at.kind,
              value: verdict.at.value,
            },
          ]
        : [],
    );
    if (against.length > 0) out.set(issueId.toLowerCase(), against);
  }
  return out;
}

/** One live criterion weighed on a landed build: it counts, or why it does not. */
export type LandedCriterion =
  | { criterion: number; counts: true; at: string }
  | { criterion: number; counts: false; why: string };

/**
 * The whole commit a verdict was judged at, or why it names none, by the one reading coverage shares
 * (contracts `landedCommitOf`); on a project naming its testing environment (`judgedOn`), a runtime
 * verdict at a whole commit names it (REQ-36 BC-18).
 */
function judgedCommit(
  verdict: CriterionVerdict,
  judgedOn: string | null,
): { sha: string } | { why: string } {
  const at = verdict.at;
  if (!at) return { why: 'it names nothing it was judged against' };
  const named = landedCommitOf(at.kind === 'source' ? 'commit' : at.kind, at.value, judgedOn);
  return 'why' in named ? { why: `it was ${named.why}` } : named;
}

/** Why a verdict at `judged` does not count on `build`, naming both commits. */
export function otherBuildWhy(judged: string, build: string): string {
  return `it was judged at \`${short(judged)}\`, not at \`${short(build)}\`: a verdict at an earlier commit judged another build, and one at a later head counts only on a record made at that head`;
}

/**
 * A verdict judged at the head of the request that merged as `build`: it counts for `build` only
 * where Forge read from the host, at the merge, that the head's tree is `build`'s
 * (`issues.merged_head`). Null where `judged` is not that head; otherwise whether it counts, in words.
 */
export function atMergedHead(
  judged: string,
  build: string,
  head: MergedHead | null | undefined,
): { counts: true; words: string } | { counts: false; why: string } | null {
  if (!head || head.sha.toLowerCase() !== judged.toLowerCase()) return null;
  if (head.treeIdentical === true) {
    return {
      counts: true,
      words: `judged at \`${short(judged)}\`, tree-identical to landing \`${short(build)}\``,
    };
  }
  if (head.treeIdentical === false) {
    return {
      counts: false,
      why: `it was judged at \`${short(judged)}\`, the head of the request that landed as \`${short(build)}\`, and the host shows the two trees differ (the base moved under it), so it judged another build`,
    };
  }
  return {
    counts: false,
    why: `it was judged at \`${short(judged)}\`, the head of the request that landed as \`${short(build)}\`, and whether the two trees are identical was not read: ${head.why ?? 'nothing says why'}`,
  };
}

/**
 * One criterion's standing on `build`: a pass or short the verified rule counts, judged at `build`
 * itself. Every other answer says what it lacks, where its verdict sits and the commit it needed.
 */
export function weighOnLanded(
  build: string,
  { criterion, verdict }: StandingCriterion,
  via: string | null = null,
  head: MergedHead | null = null,
  judgedOn: string | null = null,
  /** Per later commit, whether it holds `build` (`landed-build-holds.ts:laterHoldersOf`); absent, none was asked. */
  holders?: ReadonlyMap<string, Holding>,
): LandedCriterion {
  const no = (why: string): LandedCriterion => ({
    criterion,
    counts: false,
    why: `${why}; it needs a \`pass\` whose identity is commit \`${short(build)}\``,
  });
  if (!verdict) return no('no verdict was recorded for it');
  if (verdict.unverified) return no(verdict.unverified);
  if (!verdictEarns(verdict.verdict)) return no(`its verdict is \`${verdict.verdict}\``);
  const judged = judgedCommit(verdict, judgedOn);
  if ('why' in judged) return no(judged.why);
  if (judged.sha !== build.toLowerCase()) {
    const atHead = atMergedHead(judged.sha, build, head);
    if (atHead?.counts) return { criterion, counts: true, at: judged.sha };
    if (atHead) return no(atHead.why);
    const held = via ? undefined : holders?.get(judged.sha);
    if (held === true) return { criterion, counts: true, at: judged.sha };
    if (held === false) {
      return no(
        `it was judged at \`${short(judged.sha)}\`, which does not hold the landing \`${short(build)}\`, so it judged another build`,
      );
    }
    if (held !== undefined) {
      return no(
        `it was judged at \`${short(judged.sha)}\`, and no record of Forge's says that holds the landing \`${short(build)}\`: ${held.unread}`,
      );
    }
    return no(via ? otherHeadWhy(judged.sha, build, via) : otherBuildWhy(judged.sha, build));
  }
  return { criterion, counts: true, at: judged.sha };
}

// Where the project's document owes no verdict, a criterion with none is not weighed, and QA may
// judge it after the landing; a verdict that is there is kernel input all the same: one whose
// identity names no commit is refused by name rather than closed over (`landedIdentityWhy`), and so
// is one judged at `build` itself that does not earn, since a missing verdict passes there but a
// recorded fail never does (ISS-630). A verdict at another commit judged another build.
function heldWhereNoneOwed(
  build: string,
  criteria: readonly StandingCriterion[],
  judgedOn: string | null,
): LandedCriterion[] {
  return criteria.flatMap(({ criterion, verdict }): LandedCriterion[] => {
    if (!verdict?.at) return [];
    const why =
      verdict.at.kind === 'source'
        ? null
        : landedIdentityWhy(verdict.at.kind, verdict.at.value, judgedOn);
    if (why) {
      return [
        {
          criterion,
          counts: false,
          why: `it was ${why}; it needs a verdict whose identity is commit \`${short(build)}\``,
        },
      ];
    }
    const judged = judgedCommit(verdict, judgedOn);
    if (verdictEarns(verdict.verdict) || !('sha' in judged) || judged.sha !== build.toLowerCase()) {
      return [];
    }
    return [
      {
        criterion,
        counts: false,
        why: `its verdict is \`${verdict.verdict}\`, judged at \`${short(build)}\`: where no verdict is owed a missing one passes, a recorded fail never does`,
      },
    ];
  });
}

/** Each issue's live criteria weighed on the build `buildOf` names for it. */
export interface LandedStanding {
  issueId: string;
  /** False where the project's document says its issues owe no verdict. */
  owes: boolean;
  criteria: LandedCriterion[];
  /** How many live criteria it has, and how many stand on a pass that counts at its build, owed or not. */
  live: number;
  passing: number;
}

/** Every live criterion of `issueIds` weighed on the build `buildOf` names for its issue. */
export async function landedStandings(
  issueIds: readonly string[],
  buildOf: (issueId: string) => string,
  viaOf: (issueId: string) => string | null = () => null,
  headOf: (issueId: string) => MergedHead | null = () => null,
  /** Asks whether each later commit a verdict names holds its issue's landing; absent, nothing is asked. */
  holdersOf?: (
    judged: ReadonlyMap<string, readonly JudgedAgainst[]>,
    judgedOnFor: (issueId: string) => string | null,
  ) => Promise<ReadonlyMap<string, ReadonlyMap<string, Holding>>>,
): Promise<LandedStanding[]> {
  const standing = await standingCriteriaOf(issueIds);
  const holders = holdersOf
    ? await holdersOf(judgedAgainstOf(standing), (id) => standing.get(id)?.judgedOn ?? null)
    : new Map<string, ReadonlyMap<string, Holding>>();
  return issueIds.flatMap((issueId) => {
    const s = standing.get(issueId);
    if (!s) return [];
    const build = buildOf(issueId);
    const later = holders.get(issueId.toLowerCase());
    const weighed = s.criteria.map((c) =>
      weighOnLanded(build, c, viaOf(issueId), headOf(issueId), s.judgedOn, later),
    );
    return [
      {
        issueId,
        owes: s.owes,
        criteria: s.owes ? weighed : heldWhereNoneOwed(build, s.criteria, s.judgedOn),
        live: s.criteria.length,
        passing: weighed.filter((c) => c.counts).length,
      },
    ];
  });
}

/**
 * Before a record, the build each issue will be recorded at, as the steward and coverage read it.
 * Where every live criterion of an issue not yet recorded stands on a counting pass at one commit,
 * and that commit is a landing Forge recorded after the one its merge names, on its branch
 * (`recorded-holding.ts`, never the host), that commit is the build: the record a master makes there will count every one of
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
      const judged = judgedCommit(verdict, s.judgedOn);
      return 'sha' in judged ? judged.sha : null;
    });
    const one = at[0];
    if (!one || one === build.sha || at.some((sha) => sha !== one)) continue;
    ahead.set(issueId, { landing: build.sha, sha: one });
  }
  if (ahead.size === 0) return out;
  const held = await recordedHolding(
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
