/**
 * The build a requirement's coverage weighs each verdict on (`standing-coverage.ts:coverageOf`): the
 * live build, an issue's landing where the release weighs its criteria there, and where it weighs at
 * what is served, the landing of each issue holding a verdict the live build does not hold
 * (ISS-1018). Moved out of `standing-facts.ts`, which reads the requirement's own facts.
 */

import { issueCoresOf } from '../issues/index.js';
import { requirementDependents } from './dependents.js';
import { recordedLandingsOf } from './recorded-landings.js';
import type { LiveBuildHolds, StandingIssueCriterion } from './standing.js';
import type { StandingRequirementVerdict } from './standing-coverage.js';

/**
 * What the live build holds of the commits `rows`' judgements name, directly or through the runtime
 * that served them, and of the commits the verdicts recorded at the requirement itself name
 * (`own`, ISS-588); null where none names either. The rows of another project's issue are read on
 * that project's own build and carried under `foreign` (`standing-identity.ts:holdsFor`): its
 * commits are never in the requirement project's build, so reading them there would say none counts.
 */
export async function liveBuildOf(
  projectId: string,
  rows: readonly StandingIssueCriterion[],
  own: readonly Pick<StandingRequirementVerdict, 'commit'>[] = [],
): Promise<LiveBuildHolds | null> {
  const owners = await issueProjectsOf(rows.map((r) => r.issueId));
  return (await buildsAcross(projectId, [{ key: '', rows, own }], owners)).get('') ?? null;
}

/**
 * Each requirement's build, as its record and its accept read it (`acceptance.ts:liveBuildOfRequirement`):
 * one read over every listed row once let another requirement's own verdicts decide which build this
 * one's were weighed on (a verdict at a requirement swapped the landing's holds for the live build's
 * of that verdict's commit alone), so the list read REQ-78 passing 0/7 while its record read 7/7
 * (owner 2026-11-08, D2). A requirement with a verdict of its own, or none of its traced rows judged,
 * is weighed alone; the rest share one ask of their traced rows. Each ask takes its own branch
 * (`commitBuildsOf`), and every ask of a project is answered from one read of each kind over all of
 * them, which holds the same of each one's commits as its own read would (each map is keyed by commit
 * or issue): a read per requirement sent each kind once a requirement (perf-cleanup-1108).
 */
export async function liveBuildsOf(
  projectId: string,
  rows: readonly {
    id: string;
    traced: readonly StandingIssueCriterion[];
    own: readonly Pick<StandingRequirementVerdict, 'commit'>[];
  }[],
): Promise<Map<string, LiveBuildHolds | null>> {
  const owners = await issueProjectsOf([
    ...new Set(rows.flatMap((r) => r.traced.map((c) => c.issueId))),
  ]);
  const alone = rows.filter((r) => r.own.some((v) => v.commit) || !weighsAny(r.traced));
  const shared = rows.filter((r) => !alone.includes(r));
  const SHARED = '\u0000shared';
  const asks = [
    ...(shared.length > 0 ? [{ key: SHARED, rows: shared.flatMap((r) => r.traced), own: [] }] : []),
    ...alone.map((r) => ({ key: r.id, rows: r.traced, own: r.own })),
  ];
  const builds = await buildsAcross(projectId, asks, owners);
  return new Map(
    rows.map((r) => [r.id, builds.get(alone.includes(r) ? r.id : SHARED) ?? null] as const),
  );
}

/** One requirement's (or one shared set's) rows and own verdicts, weighed on its own branch. */
interface BuildAsk {
  key: string;
  rows: readonly StandingIssueCriterion[];
  own: readonly Pick<StandingRequirementVerdict, 'commit'>[];
}

/**
 * {@link liveBuildOf} for each ask: its rows split by the issue's project, each project's asks
 * weighed together (`projectBuildsOf`), another project's carried under `foreign`. Every project's
 * build is read at once, never one after another (ISS-1070 r17).
 */
async function buildsAcross(
  projectId: string,
  asks: readonly BuildAsk[],
  owners: ReadonlyMap<string, string>,
): Promise<Map<string, LiveBuildHolds | null>> {
  const byProject = new Map<string, BuildAsk[]>([[projectId, []]]);
  const theirsOf = new Map<string, Map<string, StandingIssueCriterion[]>>();
  for (const ask of asks) {
    const mine: StandingIssueCriterion[] = [];
    const theirs = new Map<string, StandingIssueCriterion[]>();
    for (const r of ask.rows) {
      const at = owners.get(r.issueId) ?? projectId;
      if (at === projectId) mine.push(r);
      else theirs.set(at, [...(theirs.get(at) ?? []), r]);
    }
    byProject.get(projectId)?.push({ key: ask.key, rows: mine, own: ask.own });
    for (const [other, those] of theirs)
      byProject.set(other, [
        ...(byProject.get(other) ?? []),
        { key: ask.key, rows: those, own: [] },
      ]);
    theirsOf.set(ask.key, theirs);
  }
  const read = new Map(
    await Promise.all(
      [...byProject].map(async ([p, some]) => [p, await projectBuildsOf(p, some)] as const),
    ),
  );
  const out = new Map<string, LiveBuildHolds | null>();
  for (const ask of asks) {
    const holds = read.get(projectId)?.get(ask.key) ?? null;
    const theirs = theirsOf.get(ask.key) ?? new Map();
    if (theirs.size === 0) {
      out.set(ask.key, holds);
      continue;
    }
    const foreign = new Map<string, LiveBuildHolds | null>();
    for (const [other, those] of theirs) {
      const build = read.get(other)?.get(ask.key) ?? null;
      for (const r of those) foreign.set(r.issueId.toLowerCase(), build);
    }
    out.set(ask.key, { ...(holds ?? NOTHING_ASKED), foreign });
  }
  return out;
}

/** Whether any of `rows` holds a verdict a build weighs (`commitBuildOf`'s gate), a voided one's included. */
const weighsAny = (rows: readonly StandingIssueCriterion[]): boolean =>
  rows.some(
    (r) =>
      r.beforeReopen?.identity?.kind === 'commit' ||
      [r, ...(r.earlier ?? [])].some(
        (v) =>
          v.verdict !== null &&
          v.verdict !== 'skipped' &&
          (v.identity?.kind === 'commit' || v.identity?.kind === 'runtime'),
      ),
  );

/** A build nothing was asked of: what carries another project's holds where this one's read none. */
const NOTHING_ASKED: LiveBuildHolds = {
  sha: null,
  holds: new Map(),
  runtimes: new Map(),
  unanswered: new Map(),
};

/** The project of each issue named, from the one read of each issue every reader shares. */
async function issueProjectsOf(issueIds: readonly string[]): Promise<Map<string, string>> {
  const cores = await issueCoresOf(issueIds);
  return new Map([...cores].map(([id, c]) => [id, c.projectId]));
}

/**
 * The build each ask's verdicts on a project are weighed on, and, where its production names no commit
 * it serves (no source probe), the releases its agent recorded (`released`, ISS-900): a verdict naming
 * a release is weighed there, and the standing names that release as the one to judge on.
 */
async function projectBuildsOf(
  projectId: string,
  asks: readonly BuildAsk[],
): Promise<Map<string, LiveBuildHolds | null>> {
  const [released, builds] = await Promise.all([
    requirementDependents().releasedLine(projectId),
    commitBuildsOf(projectId, asks),
  ]);
  return new Map(
    asks.map((a) => {
      const build = builds.get(a.key) ?? null;
      return [a.key, released ? { ...(build ?? NOTHING_ASKED), released } : build] as const;
    }),
  );
}

/** What one ask's verdicts name: the commits and runtimes judged, its own commits, a voided commit. */
function namedBy(ask: BuildAsk) {
  const judged = ask.rows
    .flatMap((r) => [r, ...(r.earlier ?? [])])
    .filter((r) => r.verdict !== null && r.verdict !== 'skipped');
  const asked = ask.own.flatMap((v) => (v.commit ? [v.commit] : []));
  return {
    commits: [
      ...judged.flatMap((r) => (r.identity?.kind === 'commit' ? [r.identity.sha] : [])),
      ...asked,
    ],
    runtimes: judged.flatMap((r) => (r.identity?.kind === 'runtime' ? [r.identity.ref] : [])),
    asked,
    voidedAtCommit: ask.rows.some((r) => r.beforeReopen?.identity?.kind === 'commit'),
  };
}

const issuesOf = (rows: readonly StandingIssueCriterion[]) => [
  ...new Set(rows.map((r) => r.issueId)),
];

/**
 * Each ask's build on `projectId`, each on its own branch (a verdict at the requirement weighs the
 * live build beside the landing; none, the landing alone), every read made once over all the asks:
 * each answer is keyed by issue or commit, so an ask reads in it only what its own read would hold.
 */
async function commitBuildsOf(
  projectId: string,
  asks: readonly BuildAsk[],
): Promise<Map<string, LiveBuildHolds | null>> {
  const out = new Map<string, LiveBuildHolds | null>(asks.map((a) => [a.key, null]));
  const named = new Map(asks.map((a) => [a.key, namedBy(a)]));
  const weighed = asks.filter((a) => {
    const n = named.get(a.key);
    return n && (n.commits.length > 0 || n.runtimes.length > 0 || n.voidedAtCommit);
  });
  if (weighed.length === 0) return out;
  const rows = weighed.flatMap((a) => a.rows);
  // Where the release weighs an issue's criteria at its landing (no production environment, or a
  // promotion before production, ISS-849), each verdict is weighed on its own issue's landing instead,
  // and a later commit it names counts where it holds that landing (`standing-identity.ts:atLanding`).
  const landed = await requirementDependents().landingHolds(
    projectId,
    issuesOf(rows),
    judgedAgainstOf(rows),
  );
  if (landed) {
    const askedAll = [...new Set(weighed.flatMap((a) => named.get(a.key)?.asked ?? []))];
    if (askedAll.length === 0) {
      for (const a of weighed) out.set(a.key, landed);
      return out;
    }
    // a verdict at the requirement itself judges the running build where production serves it, and
    // is weighed on a landing Forge recorded otherwise (`standing-identity.ts:atRecordedLanding`)
    const extra = landed.promoted
      ? ((await requirementDependents().liveBuildHolds(projectId, {
          commits: askedAll,
          runtimes: [],
        })) ?? {})
      : { recordedLandings: await recordedLandingsOf(projectId, askedAll, issuesOf(rows)) };
    for (const a of weighed)
      out.set(a.key, (named.get(a.key)?.asked.length ?? 0) > 0 ? { ...landed, ...extra } : landed);
    return out;
  }
  const live = await requirementDependents().liveBuildHolds(projectId, {
    commits: [...new Set(weighed.flatMap((a) => named.get(a.key)?.commits ?? []))],
    runtimes: [...new Set(weighed.flatMap((a) => named.get(a.key)?.runtimes ?? []))],
  });
  if (!live) return out;
  const asking = weighed.filter((a) => {
    const n = named.get(a.key);
    return n && (n.commits.length > 0 || n.runtimes.length > 0);
  });
  // where the live build does not hold a verdict, it is weighed at its issue's landing (ISS-1018)
  const unheld = new Map(asking.map((a) => [a.key, unheldOf(judgedAgainstOf(a.rows), live)]));
  const all = new Map<string, { kind: string; value: string }[]>();
  for (const u of unheld.values())
    for (const [issueId, commits] of u) all.set(issueId, [...(all.get(issueId) ?? []), ...commits]);
  const landings =
    all.size > 0
      ? await requirementDependents().servedLandings(projectId, [...all.keys()], all)
      : null;
  for (const a of asking)
    out.set(a.key, landings && (unheld.get(a.key)?.size ?? 0) > 0 ? { ...live, landings } : live);
  return out;
}

/**
 * Per issue, the commits its verdicts name that the live build does not hold, or whose hold nobody
 * could say: a runtime as the commit it served (`LiveBuildHolds.runtimes`), which is what the landing
 * weighs; one that served no commit nothing places, and is left out.
 */
function unheldOf(
  judged: ReadonlyMap<string, readonly { kind: string; value: string }[]>,
  live: LiveBuildHolds,
): Map<string, { kind: string; value: string }[]> {
  const out = new Map<string, { kind: string; value: string }[]>();
  for (const [issueId, against] of judged) {
    const commits = against.flatMap((a) => {
      const sha =
        a.kind === 'commit' ? a.value.toLowerCase() : live.runtimes.get(a.value.toLowerCase());
      return sha && live.holds.get(sha) !== true ? [{ kind: 'commit', value: sha }] : [];
    });
    if (commits.length > 0) out.set(issueId, commits);
  }
  return out;
}

/** Per issue, the commit and runtime identities its verdicts name, a voided one's included. */
function judgedAgainstOf(
  rows: readonly StandingIssueCriterion[],
): Map<string, { kind: string; value: string }[]> {
  const out = new Map<string, { kind: string; value: string }[]>();
  for (const r of rows) {
    for (const v of [r, ...(r.earlier ?? []), ...(r.beforeReopen ? [r.beforeReopen] : [])]) {
      const id = v.identity;
      if (v.verdict === null || !id || (id.kind !== 'commit' && id.kind !== 'runtime')) continue;
      const value = id.kind === 'commit' ? id.sha : id.ref;
      out.set(r.issueId, [...(out.get(r.issueId) ?? []), { kind: id.kind, value }]);
    }
  }
  return out;
}
