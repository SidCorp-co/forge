// @direct-test-of packages/core/src/release-batch/served-carriage.ts
// @direct-test-of packages/core/src/release-batch/criterion-reading.ts
// @direct-test-of packages/core/src/release-batch/served-over.ts
// ISS-1290: forge-dev served 0.4.0-dev.717 (4198c1a6), which descends from 0.4.0-dev.716's head
// (eff4f0b5), when ISS-1272 c1 was judged there; dev.717's commits touch none of the issue's files, and
// dev.716 still read 0 of 33 proven: a commit pass counted only at the release's own build. Its issues
// were placed on it by shipped-in records after the cut, so its roster names them as these fixtures do.

import { describe, expect, it } from 'vitest';
import { type CriterionReading, criterionReadingsAt } from './criterion-reading.js';
import type { CarriedVerdict, IssueFact } from './release-facts.js';
import { type ServedCarriageDeps, servedCarriagesOf } from './served-carriage.js';
import type { KeptRange } from './shipped-range.js';
import type { ShippedReleaseRun } from './shipped-releases.js';

const HEAD = 'eff4f0b5e47ad307061b79258a484667b9fdcedd';
const LIVE = '4198c1a695d5421815d2aa2281580d3c6ebbe39d';
const BASE = '565075a0fcdee6efd1df7975d376f58269f5f746';
const ISSUE_ID = '135d4eeb-b2b1-405c-bf73-b1e763bb365c';
const FILE = 'packages/core/src/masters/owed-standings.ts';
const MARKED = 'packages/core/src/guides/master-guide.test.ts';

const release = (version: string, commit: string, issueIds: string[]): ShippedReleaseRun => ({
  runId: `run-${version}`,
  version,
  commit,
  issueIds,
  cutAt: new Date('2026-11-17T17:32:06Z'),
});
const DEV_716 = release('0.4.0-dev.716', HEAD, [ISSUE_ID]);
const DEV_717 = release('0.4.0-dev.717', LIVE, ['other-issue']);

const changedIn = (paths: string[], base: string, head: string): KeptRange => ({
  base,
  head,
  changed: paths.map((path) => ({ path, change: 'changed' as const })),
});
// as a runner at ISS-1259 or later reports it: each commit with its subject and files
const REPORTED_716: KeptRange = {
  ...changedIn([FILE, MARKED, 'CHANGELOG.md'], BASE, HEAD),
  commits: [
    {
      sha: 'a'.repeat(40),
      subject: 'fix(masters): a triage it may accept (ISS-1273)',
      paths: [FILE],
    },
    { sha: 'b'.repeat(40), subject: 'test(guides): another issue (ISS-1279)', paths: [MARKED] },
  ],
};
// as dev.716's was kept on forge-dev: by a runner older than ISS-1259, with no commits
const OLD_716 = changedIn([FILE, MARKED, 'CHANGELOG.md'], BASE, HEAD);

let seq = 0;
function pass(commitSha: string): CarriedVerdict {
  seq += 1;
  const at = new Date(Date.UTC(2026, 10, 17, 18, seq)).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    criterionId: 'c1',
    verdict: 'pass',
    identityKind: 'commit',
    commitSha,
    runtimeRef: null,
    releaseVersion: null,
    acceptedOn: null,
    at,
    reason: 'held live',
    evidence: [],
    agency: 'agent',
    byBuilder: false,
    authored: true,
    recordedAt: at,
  };
}

function issueJudgedAt(commit: string): IssueFact {
  return {
    id: ISSUE_ID,
    key: 'ISS-1273',
    title: 'ISS-1273',
    status: 'closed',
    updatedAt: new Date(0),
    releaseNotes: null,
    requirementId: null,
    criteria: [
      {
        n: 1,
        statement: 'criterion 1',
        standing: 'pass',
        bc: null,
        identity: null,
        reason: null,
        judgedAt: null,
        judgedBy: null,
        proven: false,
        unverified: null,
      },
    ],
    classes: new Map(),
    verdicts: new Map([[1, [pass(commit)]]]),
    voided: new Map(),
    reopenedAt: null,
    closedAt: [],
    // a batch mark: it names a commit of another issue, so its paths alone are not the issue's files
    merged: {
      at: new Date('2026-11-17T17:08:22Z'),
      landing: null,
      artifacts: null,
      commitSha: null,
      readPaths: {
        read: 'box',
        commit: 'b'.repeat(40),
        changes: [{ path: MARKED, change: 'changed' }],
      },
    },
  };
}

function deps(ranges: Record<string, KeptRange>): ServedCarriageDeps {
  return {
    releases: async () => [DEV_716, DEV_717],
    heldAncestry: async () => new Map(),
    ranges: async (ids) =>
      new Map(ids.flatMap((id) => (ranges[id] ? [[id, ranges[id]] as const] : []))),
  };
}

/** Criterion 1 as release dev.716 reads it, the issue judged at `commit`, over `ranges`. */
async function onDev716(
  commit: string,
  ranges: Record<string, KeptRange>,
  judgedOn: string | null = null,
): Promise<CriterionReading> {
  const issue = issueJudgedAt(commit);
  const served = await servedCarriagesOf(
    'forge',
    new Map([[issue.id, issue]]),
    judgedOn,
    deps(ranges),
  );
  const [reading] = criterionReadingsAt(
    issue,
    HEAD,
    { judge: 'independent', judgedOn, served },
    DEV_716.version,
  );
  return reading as CriterionReading;
}

describe('a pass judged at a later served build, on the release it carries (ISS-1290)', () => {
  it('counts on the release where the later build descends from its head and its commits touch none of the issue files', async () => {
    const read = await onDev716(LIVE, {
      [DEV_716.runId]: REPORTED_716,
      [DEV_717.runId]: changedIn(['packages/core/src/lessons/pass.ts'], HEAD, LIVE),
    });
    expect(
      read.view.proven,
      'ISS-1290: a pass at a later served build that carries the release unchanged counts on that release',
    ).toBe(true);
    expect(read.view).toMatchObject({ standing: 'pass', unverified: null });
    expect(read.onBuild?.commitSha).toBe(LIVE);
  });

  it('does not count where a commit between touches one of the issue files, and names the file', async () => {
    const read = await onDev716(LIVE, {
      [DEV_716.runId]: REPORTED_716,
      [DEV_717.runId]: changedIn([FILE], HEAD, LIVE),
    });
    expect(read.view).toMatchObject({ proven: false, standing: 'unjudged' });
    expect(read.view.unverified).toContain(`\`${FILE}\``);
  });

  it('names what is missing where the release range kept no commits, never a silent unjudged', async () => {
    const read = await onDev716(LIVE, {
      [DEV_716.runId]: OLD_716,
      [DEV_717.runId]: changedIn(['packages/core/src/lessons/pass.ts'], HEAD, LIVE),
    });
    expect(read.view.proven).toBe(false);
    expect(read.view.unverified).toContain('kept no commits');
    expect(read.view.unverified).toContain(
      `\`forge-runner release range --project-id forge\` with \`--run ${DEV_716.runId} --head ${HEAD}\` (0.4.0-dev.716)`,
    );
  });

  it('names a later build no release Forge verified, and never counts a pass at an earlier one', async () => {
    const unrecorded = await onDev716('c'.repeat(40), { [DEV_716.runId]: REPORTED_716 });
    expect(unrecorded.view.proven).toBe(false);
    expect(unrecorded.view.unverified).toContain('is no release Forge verified');
    const earlier = await onDev716(BASE, {});
    expect(earlier.view.proven).toBe(false);
  });

  it('weighs nothing where the project proves releases on a testing environment', async () => {
    const read = await onDev716(
      LIVE,
      {
        [DEV_716.runId]: REPORTED_716,
        [DEV_717.runId]: changedIn(['x.ts'], HEAD, LIVE),
      },
      'staging',
    );
    expect(read.view.proven).toBe(false);
  });
});
