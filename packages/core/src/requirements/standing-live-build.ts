/**
 * The build a requirement's coverage weighs each verdict on (`standing-coverage.ts:coverageOf`): the
 * live build, an issue's landing where the release weighs its criteria there, and where it weighs at
 * what is served, the landing of each issue holding a verdict the live build does not hold
 * (ISS-1018). Moved out of `standing-facts.ts`, which reads the requirement's own facts.
 */

import { issueCoresOf } from '../issues/index.js';
import { createLimiter } from '../lib/bounded-concurrency.js';
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
  read: BuildRead = buildRead(),
): Promise<LiveBuildHolds | null> {
  const owners = await read.owners(rows.map((r) => r.issueId));
  const theirs = new Map<string, StandingIssueCriterion[]>();
  const mine: StandingIssueCriterion[] = [];
  for (const r of rows) {
    const at = owners.get(r.issueId) ?? projectId;
    if (at === projectId) mine.push(r);
    else theirs.set(at, [...(theirs.get(at) ?? []), r]);
  }
  const holds = await projectBuildOf(projectId, mine, own, read);
  if (theirs.size === 0) return holds;
  const foreign = new Map<string, LiveBuildHolds | null>();
  for (const [other, those] of theirs) {
    const build = await projectBuildOf(other, those, [], read);
    for (const r of those) foreign.set(r.issueId.toLowerCase(), build);
  }
  return { ...(holds ?? NOTHING_ASKED), foreign };
}

/**
 * What one read shares across the requirements it weighs: each issue's project, and each project's
 * recorded release line. Neither depends on a requirement's own verdicts, so reading them once per
 * read keeps each requirement's build its own (`liveBuildsOf`) without a statement per requirement.
 */
interface BuildRead {
  owners(issueIds: readonly string[]): Promise<Map<string, string>>;
  released(projectId: string): ReturnType<ReturnType<typeof requirementDependents>['releasedLine']>;
}

function buildRead(prefetched?: Promise<Map<string, string>>): BuildRead {
  const lines = new Map<string, ReturnType<BuildRead['released']>>();
  return {
    owners: async (ids) => {
      const known = prefetched ? await prefetched : new Map<string, string>();
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length === 0) return known;
      return new Map([...known, ...(await issueProjectsOf(missing))]);
    },
    released: (projectId) => {
      let line = lines.get(projectId);
      if (!line) {
        line = requirementDependents().releasedLine(projectId);
        lines.set(projectId, line);
      }
      return line;
    },
  };
}

/** How many requirements' builds one read weighs at once. */
const LIVE_BUILD_READS = 4;

/**
 * Each requirement's build, as its record and its accept read it (`acceptance.ts:liveBuildOfRequirement`):
 * one read over every listed row once let another requirement's own verdicts decide which build this
 * one's were weighed on (a verdict at a requirement swapped the landing's holds for the live build's
 * of that verdict's commit alone), so the list read REQ-78 passing 0/7 while its record read 7/7
 * (owner 2026-11-08, D2). A requirement with a verdict of its own, or none of its traced rows judged,
 * is read alone; the rest share one read of their traced rows, which holds the same of each one's
 * commits as its own read would (each map is keyed by commit or issue), at one read's statements.
 */
export async function liveBuildsOf(
  projectId: string,
  rows: readonly {
    id: string;
    traced: readonly StandingIssueCriterion[];
    own: readonly Pick<StandingRequirementVerdict, 'commit'>[];
  }[],
): Promise<Map<string, LiveBuildHolds | null>> {
  const read = buildRead(
    issueProjectsOf([...new Set(rows.flatMap((r) => r.traced.map((c) => c.issueId)))]),
  );
  const alone = rows.filter((r) => r.own.some((v) => v.commit) || !weighsAny(r.traced));
  const shared = rows.filter((r) => !alone.includes(r));
  const limit = createLimiter(LIVE_BUILD_READS);
  const [together, ...each] = await Promise.all([
    shared.length > 0
      ? liveBuildOf(
          projectId,
          shared.flatMap((r) => r.traced),
          [],
          read,
        )
      : Promise.resolve(null),
    ...alone.map((r) =>
      limit.run(async () => [r.id, await liveBuildOf(projectId, r.traced, r.own, read)] as const),
    ),
  ]);
  return new Map([...shared.map((r) => [r.id, together] as const), ...each]);
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
 * The build a project's verdicts are weighed on, and, where its production names no commit it serves
 * (no source probe), the releases its agent recorded (`released`, ISS-900): a verdict naming a release
 * is weighed there, and the standing names that release as the one to judge on.
 */
async function projectBuildOf(
  projectId: string,
  rows: readonly StandingIssueCriterion[],
  own: readonly Pick<StandingRequirementVerdict, 'commit'>[],
  read: BuildRead,
): Promise<LiveBuildHolds | null> {
  const [released, build] = await Promise.all([
    read.released(projectId),
    commitBuildOf(projectId, rows, own),
  ]);
  return released ? { ...(build ?? NOTHING_ASKED), released } : build;
}

async function commitBuildOf(
  projectId: string,
  rows: readonly StandingIssueCriterion[],
  own: readonly Pick<StandingRequirementVerdict, 'commit'>[],
): Promise<LiveBuildHolds | null> {
  const judged = rows
    .flatMap((r) => [r, ...(r.earlier ?? [])])
    .filter((r) => r.verdict !== null && r.verdict !== 'skipped');
  const commits = [
    ...judged.flatMap((r) => (r.identity?.kind === 'commit' ? [r.identity.sha] : [])),
    ...own.flatMap((v) => (v.commit ? [v.commit] : [])),
  ];
  const runtimes = judged.flatMap((r) => (r.identity?.kind === 'runtime' ? [r.identity.ref] : []));
  const voidedAtCommit = rows.some((r) => r.beforeReopen?.identity?.kind === 'commit');
  if (commits.length === 0 && runtimes.length === 0 && !voidedAtCommit) return null;
  // Where the release weighs an issue's criteria at its landing (no production environment, or a
  // promotion before production, ISS-849), each verdict is weighed on its own issue's landing instead,
  // and a later commit it names counts where it holds that landing (`standing-identity.ts:atLanding`).
  const landed = await requirementDependents().landingHolds(
    projectId,
    [...new Set(rows.map((r) => r.issueId))],
    judgedAgainstOf(rows),
  );
  if (landed) {
    const asked = own.flatMap((v) => (v.commit ? [v.commit] : []));
    if (asked.length === 0) return landed;
    if (landed.promoted) {
      // a verdict at the requirement itself judges the running build, which production serves here
      const live = await requirementDependents().liveBuildHolds(projectId, {
        commits: asked,
        runtimes: [],
      });
      return { ...landed, ...(live ?? {}) };
    }
    // a verdict at the requirement itself is weighed on a landing Forge recorded (`standing-identity.ts:atRecordedLanding`)
    const recordedLandings = await recordedLandingsOf(projectId, asked, [
      ...new Set(rows.map((r) => r.issueId)),
    ]);
    return { ...landed, recordedLandings };
  }
  if (commits.length === 0 && runtimes.length === 0) return null;
  const live = await requirementDependents().liveBuildHolds(projectId, { commits, runtimes });
  if (!live) return null;
  // where the live build does not hold a verdict, it is weighed at its issue's landing (ISS-1018)
  const unheld = unheldOf(judgedAgainstOf(rows), live);
  if (unheld.size === 0) return live;
  const landings = await requirementDependents().servedLandings(
    projectId,
    [...unheld.keys()],
    unheld,
  );
  return { ...live, landings };
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
