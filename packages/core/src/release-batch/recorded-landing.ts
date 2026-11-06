// The record of a landing, on a project that declares no production environment (release mode
// `none`). Landing on the working branch IS the delivery there (owner ruling 2026-10-22), so the
// release a closed issue owes (`CLOSE_ONLY_BY_RELEASE`) is this record: it names the branch, says
// nothing was deployed, and closes what it claimed as a finished release does.
//
// A landing that happened is recorded as the fact it is (REQ-45 r7 BC-11; owner rulings 2026-10-27
// and 2026-11-01, `release-is-the-agents-record`): the agent's own words, under the version it names
// or one Forge cuts. A commit is optional evidence, kept and never required, compared or read for
// ancestry. It refuses only what is not a fact: a malformed body, an issue that carries no mark. A
// mark naming no commit is the agent's word too (ISS-1017): it is recorded, its build said unread.
// Verdicts gate a merge or a cut only where the project's gates ask it (BC-15: an owed merge check's
// probes, an enforced `release_criteria`), and never a landing that already happened: each issue's coverage at its landing is read beside the record
// (`landing-coverage.ts`, BC-14), refusing nothing.

import { db } from '../db/client.js';
import { issueDisplayIds, releaseRunClaims } from '../issues/index.js';
import { emitEvent } from '../outbox/index.js';
import { insertOneShotRun } from '../pipeline/index.js';
import { admitRoster } from './blockers.js';
import { claimRoster, RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import type { JudgedBuildDeps } from './judged-build.js';
import { LANDED_VERIFICATION, landedBuildsOf } from './landed-build.js';
import { type CriterionCoverage, landingCoverage, shippedFailingOf } from './landing-coverage.js';
import { carryNaming } from './naming.js';
import {
  admissibleIssues,
  closeRecorded,
  endRecordRun,
  type RecordPerformedReleaseArgs,
  type RecordPerformedReleaseResult,
  writeLedger,
} from './recorded.js';
import { refuseRelease } from './refuse.js';
import { oweReleaseTag } from './release-tag.js';
import { cutReleaseVersion, takeGivenVersion } from './version-store.js';

const short = (sha: string) => sha.slice(0, 12);

type LandingDeps = Pick<JudgedBuildDeps, 'ancestry'>;
type LandedBuilds = Awaited<ReturnType<typeof landedBuildsOf>>;

/**
 * Each issue's criteria coverage at its own landing (BC-14): the commit the agent named where it
 * named one, else the commit the issue's own landing records. A reading, never a refusal.
 */
async function coverageAtLandings(
  projectId: string,
  issueIds: readonly string[],
  commit: string | null,
  landed: LandedBuilds,
  shown: ReadonlyMap<string, string>,
  deps: LandingDeps | undefined,
): Promise<{ readings: string[]; coverage: Map<string, CriterionCoverage[]> }> {
  const byCommit = new Map<string, string[]>();
  for (const id of issueIds) {
    const at = commit ?? landed.get(id)?.sha ?? null;
    if (at) byCommit.set(at, [...(byCommit.get(at) ?? []), id]);
  }
  const readings: string[] = [];
  const coverage = new Map<string, CriterionCoverage[]>();
  for (const [at, ids] of byCommit) {
    // the landing's own commit is the build here, so a merged head's tree identity speaks only for it
    const headOf = (id: string) => {
      const build = landed.get(id);
      return build?.sha === at ? (build.head ?? null) : null;
    };
    const read = await landingCoverage(projectId, ids, at, shown, headOf, deps);
    readings.push(...read.readings);
    for (const [id, c] of read.coverage) coverage.set(id, c);
  }
  return { readings, coverage };
}

/** The account the issue carries: where it landed, that nothing deployed, and the caller's words. */
function landingNote(
  branch: string,
  version: string,
  commit: string | null,
  readings: readonly string[],
  account: string,
) {
  const lines = readings.map((r) => `- ${r}`).join('\n');
  const at = commit ? ` at \`${commit}\`` : '';
  return `Landed on \`${branch}\` as ${version}${at}, recorded by the agent — no environment. This project declares no production environment, so its landing on \`${branch}\` is its delivery and nothing was deployed.\n\n${lines}\n\n${account}`;
}

/**
 * Record a landing as the release of a project with no production environment, and close what it
 * carried. `args.branch` names the branch it landed on, the declared landing branch where it names
 * none; `args.version` the version the agent names, one Forge cuts where absent; `args.commit` the
 * agent's evidence, kept and never checked. A record refused leaves every issue where it stood.
 */
export async function recordLanding(
  args: RecordPerformedReleaseArgs,
  declared: string | null,
  deps?: LandingDeps,
): Promise<RecordPerformedReleaseResult> {
  const { projectId, account, userId } = args;
  const commit = args.commit?.trim().toLowerCase() || null;
  const providerRef = args.providerRef ?? null;
  const branch = args.branch ?? declared;
  if (!branch) {
    throw refuseRelease(
      'RELEASE_LANDING_NO_BRANCH',
      'This project declares no production environment and no `source.git.defaultBranch`, so there is no branch a landing could be recorded on. Declare the branch work lands on in the project document (PUT /api/projects/:id/config).',
    );
  }

  const { issueIds } = await admitRoster(projectId, args.issueIds, 'record');
  // every issue admitted carries a mark (`RELEASE_WORK_UNMERGED` otherwise): the mark is the agent's
  // word that it landed (ISS-1017), so one naming no commit is recorded, its build said unread
  const [landed, shown] = await Promise.all([landedBuildsOf(issueIds), issueDisplayIds(issueIds)]);

  const { readings: covered, coverage } = await coverageAtLandings(
    projectId,
    issueIds,
    commit,
    landed,
    shown,
    deps,
  );
  // a fail that shipped is said first and whole: it is the evidence the follow-up starts from
  const shippedFailing = shippedFailingOf(issueIds, coverage, shown);
  const said = commit ? ` at \`${short(commit)}\`` : '';
  const readings = [
    ...(shippedFailing ? [shippedFailing.sentence] : []),
    `landed on \`${branch}\`${said}, recorded by the agent`,
    ...issueIds.flatMap((id) => {
      const build = landed.get(id);
      if (!build) return [];
      return [build.sha === null ? build.why : build.basis];
    }),
    ...covered,
  ];

  const roster = await admissibleIssues(projectId, issueIds);
  // A recorded landing is a release like any other: it wears the version the agent names, else the
  // next one Forge cuts, in the transaction that opens it (catalog-api run 9ed968de, 2026-10-26).
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
        ...(shippedFailing ? { shippedFailing } : {}),
      },
    });
    const cut = args.version
      ? await takeGivenVersion(tx, { runId: row.id, projectId, version: args.version })
      : await cutReleaseVersion(tx, { runId: row.id, projectId, issueIds });
    await carryNaming(tx, {
      projectId,
      version: cut,
      runId: row.id,
      given: null,
      by: userId,
      roster: issueIds,
    });
    await emitEvent(tx, 'release.cut', { projectId, runId: row.id, version: cut });
    // a commit the agent named is the cut's commit (REQ-63 BC-13): its tag is owed in the same unit
    if (commit) await oweReleaseTag(row.id, commit, 'record', tx);
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
    version,
  });
  const note = landingNote(branch, version, commit, readings, account);
  const { closed, failed } = await closeRecorded(roster, {
    projectId,
    userId,
    account,
    note,
    runId: run.id,
  });
  // As the record of a release production serves: the claim is the lock, never the index.
  await releaseRunClaims(run.id);
  // the landing is the delivery: a record that closed any of what it claimed shipped, as a finished
  // release, and what it could not close is its residue (ISS-928)
  await endRecordRun(run.id, version, { closed, failed });

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
    shippedFailing,
  };
}
