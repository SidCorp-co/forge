// The record of a landing, on a project that declares no production environment (release mode
// `none`). Landing on the working branch IS the delivery there (owner ruling 2026-10-22), so the
// release a closed issue owes (`CLOSE_ONLY_BY_RELEASE`) is this record: it names the branch and the
// commit, says nothing was deployed, and closes what it claimed as a finished release does.
//
// It is held to evidence the record can show, read before anything is claimed: every issue's landing
// (`landed-build.ts`) is in the commit, and every live criterion stands on a pass judged at that very
// commit — the landed head the record names, never an ancestor of it and never a later head. Whether
// the landing is in the commit is read by the project's ancestry reader — the source host, or the box
// holding a bound checkout where the repository is local to it — and a pair nobody could read refuses
// the record by name. Whether the commit is on the branch is read only where a source host is bound;
// the box answers commit pairs, never a branch, and the record says which.

import { db } from '../db/client.js';
import { issueDisplayIds, releaseRunClaims } from '../issues/index.js';
import { type Refusal, RefusalError } from '../lib/refusal.js';
import { emitEvent } from '../outbox/index.js';
import { closeRunIfOneShot, insertOneShotRun, stampReleaseShipped } from '../pipeline/index.js';
import { pairKey } from '../runners/index.js';
import { admitRoster } from './blockers.js';
import { claimRoster, RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import type { JudgedBuildDeps } from './judged-build.js';
import {
  type Holding,
  holdingPair,
  LANDED_VERIFICATION,
  landedBuildsOf,
  landedStandings,
  readHolding,
} from './landed-build.js';
import { carryNaming } from './naming.js';
import {
  admissibleIssues,
  closeRecorded,
  type RecordPerformedReleaseArgs,
  type RecordPerformedReleaseResult,
  writeLedger,
} from './recorded.js';
import { refuseRelease } from './refuse.js';
import { ancestrySourceFor } from './shipped-earlier.js';
import { cutReleaseVersion } from './version-store.js';

const WHOLE = /^[0-9a-f]{40}$/;
const short = (sha: string) => sha.slice(0, 12);

type LandingDeps = Pick<JudgedBuildDeps, 'ancestry'>;

/** Each issue's landing in `commit`, refused by name where it is not, or where nobody could say. */
function landingRefusals(
  ids: readonly string[],
  shown: ReadonlyMap<string, string>,
  landed: Awaited<ReturnType<typeof landedBuildsOf>>,
  holding: ReadonlyMap<string, Holding>,
  commit: string,
): Refusal[] {
  return ids.flatMap((id): Refusal[] => {
    const key = shown.get(id) ?? id;
    const build = landed.get(id);
    if (!build || build.sha === null) {
      const why = build?.why ?? `${key} was not found on this project`;
      return [{ code: 'RELEASE_LANDING_UNRECORDED', path: '/issueIds', detail: why }];
    }
    const held = holding.get(pairKey(holdingPair(build.sha, commit)));
    if (held === true) return [];
    if (held === false) {
      return [
        {
          code: 'RELEASE_LANDING_NOT_IN_COMMIT',
          path: '/commit',
          detail: `${build.basis}, and \`${short(commit)}\` does not hold it: record the commit ${key} landed at, or one holding it`,
        },
      ];
    }
    return [
      {
        code: 'RELEASE_LANDING_UNREAD',
        path: '/commit',
        detail: `${build.basis}, and whether \`${short(commit)}\` holds it could not be read: ${held?.unread ?? 'it was not asked'}`,
      },
    ];
  });
}

/** Whether the commit is on the branch, where a source host can say; the box reads no branch. */
async function branchReading(
  projectId: string,
  branch: string,
  commit: string,
): Promise<{ off: true } | { off: false; reading: string }> {
  const unread = (why: string) => ({
    off: false as const,
    reading: `whether \`${branch}\` contains \`${short(commit)}\` was not read: ${why}`,
  });
  const source = await ancestrySourceFor(projectId);
  if (source.kind === 'box')
    return unread('no source host is bound, and a box reads commit ancestry, not a branch');
  if (source.kind === 'none') return unread(source.why);
  try {
    if (!(await source.host.branchContains(branch, commit))) return { off: true };
    return { off: false, reading: `the source host reads \`${short(commit)}\` on \`${branch}\`` };
  } catch (err) {
    return unread(err instanceof Error ? err.message : String(err));
  }
}

/** The account the issue carries: where it landed, that nothing deployed, and the caller's words. */
function landingNote(branch: string, commit: string, readings: readonly string[], account: string) {
  const lines = readings.map((r) => `- ${r}`).join('\n');
  return `Landed on \`${branch}\` at \`${commit}\` — no environment. This project declares no production environment, so its landing on \`${branch}\` is its delivery and nothing was deployed.\n\n${lines}\n\n${account}`;
}

/**
 * Record a landing as the release of a project with no production environment, and close what it
 * carried. Everything is read before anything is claimed, so a record that cannot be earned leaves
 * every issue where it stood, and names each reason at once.
 */
export async function recordLanding(
  args: RecordPerformedReleaseArgs,
  branch: string | null,
  deps?: LandingDeps,
): Promise<RecordPerformedReleaseResult> {
  const { projectId, account, userId } = args;
  const commit = args.commit.trim().toLowerCase();
  const providerRef = args.providerRef ?? null;
  if (!branch) {
    throw refuseRelease(
      'RELEASE_LANDING_NO_BRANCH',
      'This project declares no production environment and no `source.git.defaultBranch`, so there is no branch a landing could be recorded on. Declare the branch work lands on in the project document (PUT /api/projects/:id/config).',
    );
  }
  if (!WHOLE.test(commit)) {
    throw refuseRelease(
      'RELEASE_LANDING_COMMIT_SHAPE',
      `\`${args.commit}\` is not a whole commit: a landing on \`${branch}\` is recorded at the 40-character sha it landed at.`,
      '/commit',
    );
  }

  const { issueIds } = await admitRoster(projectId, args.issueIds, 'record');
  const [landed, shown] = await Promise.all([landedBuildsOf(issueIds), issueDisplayIds(issueIds)]);
  const landings = [...landed.values()].flatMap((b) => (b.sha ? [holdingPair(b.sha, commit)] : []));
  const holding = await readHolding(projectId, landings, deps);
  const refusals = landingRefusals(issueIds, shown, landed, holding, commit);
  const standings = await landedStandings(issueIds, () => commit);
  for (const s of standings) {
    const key = shown.get(s.issueId) ?? s.issueId;
    for (const c of s.criteria) {
      if (c.counts) continue;
      refusals.push({
        code: 'RELEASE_LANDING_UNJUDGED',
        path: '/issueIds',
        detail: `${key} criterion ${c.criterion}: ${c.why}`,
      });
    }
  }
  if (refusals.length > 0) throw new RefusalError(refusals, 'RELEASE_REFUSED');

  const readings = [
    ...issueIds.map((id) => {
      const build = landed.get(id);
      const via = build?.sha === commit ? 'is' : 'is held by';
      return `${build?.sha ? build.basis : id}, which ${via} \`${short(commit)}\``;
    }),
    ...standings.map((s) => {
      const key = shown.get(s.issueId) ?? s.issueId;
      return s.owes
        ? `${key}: every live criterion (${s.criteria.length}) stands on a pass judged at \`${short(commit)}\``
        : // owed or not, a pass recorded at the commit is named (adminhub-fe ISS-50 read "owe no verdict" over 3 passes)
          `${key}: the project's document says its issues owe no verdict; ${s.passing} of ${s.live} live criteria stand on a pass judged at \`${short(commit)}\``;
    }),
  ];
  const onBranch = await branchReading(projectId, branch, commit);
  if (onBranch.off) {
    throw refuseRelease(
      'RELEASE_LANDING_NOT_IN_COMMIT',
      `the source host reads \`${commit}\` as not on \`${branch}\`, the branch this project's work lands on: record a commit on \`${branch}\`.`,
      '/commit',
    );
  }
  readings.push(onBranch.reading);

  const roster = await admissibleIssues(projectId, issueIds);
  // A recorded landing is a release like any other: it takes the next version and its name in the
  // transaction that opens it (catalog-api run 9ed968de, 2026-10-26, recorded with no version, which
  // no release page could show and the naming door could not name).
  const { run, version } = await db.transaction(async (tx) => {
    const row = await insertOneShotRun(tx, {
      projectId,
      kind: 'system',
      metadata: {
        source: RELEASE_RECORD_SOURCE,
        gateStatus: RELEASE_GATE_STATUS,
        issueIds,
        commit,
        branch,
        identity: commit,
        verification: LANDED_VERIFICATION,
        providerRef,
        recordedBy: userId,
        issues: roster,
      },
    });
    const cut = await cutReleaseVersion(tx, { runId: row.id, projectId, issueIds });
    await carryNaming(tx, {
      projectId,
      version: cut,
      runId: row.id,
      given: null,
      by: userId,
      roster: issueIds,
    });
    await emitEvent(tx, 'release.cut', { projectId, runId: row.id, version: cut });
    return { run: row, version: cut };
  });
  await claimRoster(projectId, issueIds, run.id);
  await writeLedger(run.id, {
    commit,
    outcome: { identity: commit, readings, health: null },
    account,
    providerRef,
    how: 'landed',
    branch,
  });
  const note = landingNote(branch, commit, readings, account);
  const { closed, failed } = await closeRecorded(roster, {
    projectId,
    userId,
    account,
    note,
    runId: run.id,
  });
  // As the record of a release production serves: the claim is the lock, never the index.
  await releaseRunClaims(run.id);
  await closeRunIfOneShot(run.id, failed.length > 0 ? 'failed' : 'completed', {
    code: 'release_record_incomplete',
    detail: `${failed.length} of the recorded issues would not close: ${failed
      .map((f) => `${f.id} (${f.reason})`)
      .join('; ')}`,
  });
  // the landing is the delivery: a record that closed what it claimed shipped, as a finished release
  if (failed.length === 0) await stampReleaseShipped(run.id);

  return {
    runId: run.id,
    version,
    commit,
    identity: commit,
    readings,
    verification: LANDED_VERIFICATION,
    branch,
    closed,
    failed,
    issues: roster,
  };
}
