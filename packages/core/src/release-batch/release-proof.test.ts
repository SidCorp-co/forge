// One proven count (REQ-35 decision 7b261fca, the owner's ruling of 2026-10-14): the release record's
// totals, its Proof panel, each issue's proof and the approval checklist read the carried criteria by
// the rule a requirement's coverage and the release page count by (contracts
// `verified-rule.ts:verifiedOf`). Before this the record counted a short as proven, so the panel read
// "4 proven" beside a page that read 3 for the same release.

import type { CriterionStanding } from '@forge/contracts/issue-vocabulary';
import type { PolicyQaMode } from '@forge/contracts/project-config';
import { describe, expect, it } from 'vitest';
import { approvalAnswersOf } from './approval-checklist.js';
import { type CarriedVerdict, criteriaAt, type IssueFact } from './release-facts.js';
import { proofOf, totalsOf } from './release-view.js';

const BUILD = 'a'.repeat(40);
const EARLIER = 'b'.repeat(40);
const BUILDER_WHY = "passed by the run that built it, and a builder's own pass never counts";

const verdict = (
  v: CarriedVerdict['verdict'],
  at: string,
  over: Partial<CarriedVerdict> = {},
): CarriedVerdict => ({
  id: `${v}-${at}`,
  criterionId: 'c',
  verdict: v,
  identityKind: 'commit',
  commitSha: BUILD,
  runtimeRef: null,
  at: `2026-10-14T${at}:00.000Z`,
  reason: null,
  evidence: [],
  agency: 'agent',
  byBuilder: false,
  authored: true,
  recordedAt: `2026-10-14T${at}:00.000Z`,
  ...over,
});

/** An issue whose criterion n carries `verdicts[n-1]`, oldest first, as `loadReleaseFacts` hands it. */
function issue(verdicts: CarriedVerdict[][]): IssueFact {
  return {
    id: 'i1',
    key: 'ISS-1',
    title: 'One',
    status: 'awaiting_release',
    updatedAt: new Date(0),
    releaseNotes: null,
    requirementId: null,
    criteria: verdicts.map((list, k) => ({
      n: k + 1,
      statement: `criterion ${k + 1}`,
      standing: (list.at(-1)?.verdict ?? 'unjudged') as CriterionStanding,
      bc: null,
      identity: null,
      reason: null,
      judgedAt: null,
      judgedBy: null,
      proven: false,
      unverified: null,
    })),
    verdicts: new Map(verdicts.map((list, k) => [k + 1, list])),
    reopenedAt: null,
    closedAt: [],
    merged: { at: null, landing: null, artifacts: null, commitSha: null, readPaths: null },
  };
}

const read = (i: IssueFact, judge: PolicyQaMode | null = null, build: string | null = BUILD) =>
  criteriaAt(i, build, { judge, judgedOn: null });

describe("a release record counts what it proves by the requirement's rule", () => {
  it('never counts a short proven: judged and unproven, never "not judged yet"', () => {
    const counted = read(issue([[verdict('pass', '10:00')], [verdict('short', '10:00')]]));
    expect(counted.map((c) => [c.standing, c.proven])).toEqual([
      ['pass', true],
      ['short', false],
    ]);
    expect(counted[1]?.unverified).toBe(
      'judged short: met short of its wording, and only a pass counts as verified',
    );
    const totals = totalsOf(counted);
    expect(totals).toEqual({ proven: 1, failing: 0, open: 0, unproven: 1, total: 2 });
    expect(proofOf(totals)).toBe('unproven');
  });

  it("does not count the builder's own pass, whatever the project's qa says, and says why", () => {
    const own = issue([[verdict('pass', '10:00', { byBuilder: true })]]);
    const [c] = read(own, 'independent');
    expect(c).toMatchObject({ standing: 'pass', proven: false, unverified: BUILDER_WHY });
    expect(proofOf(totalsOf(read(own, 'independent')))).toBe('unproven');
    // REQ-74 BC-2: recorded after the cutover, it never counts, under self or no policy either
    const late = issue([
      [verdict('pass', '10:00', { byBuilder: true, recordedAt: '2026-10-26T10:00:00.000Z' })],
    ]);
    expect(read(late, 'self')[0]).toMatchObject({ proven: false, unverified: BUILDER_WHY });
    expect(read(late, null)[0]?.proven).toBe(false);
    // recorded before it, it keeps counting under self or no policy (BUILDER_PASS_CUTOVER)
    expect(read(own, 'self')[0]?.proven).toBe(true);
    expect(read(own, null)[0]?.proven).toBe(true);
  });

  it("reads the judge's pass under a newer pass of the builder's, and shows the verdict it stands on", () => {
    const i = issue([
      [verdict('pass', '10:00'), verdict('short', '11:00', { byBuilder: true, reason: 'mine' })],
    ]);
    const [c] = read(i, 'independent');
    expect(c).toMatchObject({ standing: 'pass', proven: true, unverified: null });
  });

  it('counts only verdicts on the build: a pass on an earlier one leaves it open', () => {
    const i = issue([[verdict('pass', '12:00', { commitSha: EARLIER })]]);
    expect(totalsOf(read(i))).toEqual({ proven: 0, failing: 0, open: 1, unproven: 0, total: 1 });
    expect(proofOf(totalsOf(read(i)))).toBe('open');
  });

  it('reads a draft, which has no build, by every verdict, and a fail fails whoever records it', () => {
    const i = issue([
      [verdict('pass', '10:00', { commitSha: EARLIER })],
      [verdict('fail', '10:00', { byBuilder: true })],
    ]);
    const totals = totalsOf(read(i, 'independent', null));
    expect(totals).toEqual({ proven: 1, failing: 1, open: 0, unproven: 0, total: 2 });
    expect(proofOf(totals)).toBe('failing');
  });

  it("approval names each unproven criterion by why it does not count, not as 'a pass'", () => {
    const i = issue([[verdict('short', '10:00')]]);
    const unproven = read(i)
      .filter((c) => !c.proven)
      .map((c) => ({ issue: i.key, n: c.n, standing: c.unverified ?? c.standing }));
    const answers = approvalAnswersOf({
      carried: [],
      unproven,
      verdictsRequired: true,
      judgedOn: null,
    });
    expect(answers.verdicts).toMatchObject({
      gap: 'Not proven: ISS-1 criterion 1 (judged short: met short of its wording, and only a pass counts as verified).',
    });
  });
});

// REQ-36 BC-18..BC-20: on a project naming its testing environment, a release is proven only by a
// pass judged on the build that environment serves, a runtime verdict at the release's commit
describe('a release of a project that names its testing environment', () => {
  const onDev = (i: IssueFact, build: string | null = BUILD) =>
    criteriaAt(i, build, { judge: null, judgedOn: 'dev' });
  const runtime = (at: string, ref = BUILD, over: Partial<CarriedVerdict> = {}) =>
    verdict('pass', at, { identityKind: 'runtime', commitSha: null, runtimeRef: ref, ...over });

  it('counts no commit verdict, and names the environment it was not judged on', () => {
    const [c] = onDev(issue([[verdict('pass', '10:00')]]));
    expect(c).toMatchObject({ standing: 'unjudged', proven: false, identity: null });
    expect(c?.unverified).toBe(
      `Not judged on dev: a release of this project is proven only by a pass judged on the build dev serves at ${BUILD.slice(0, 12)} (a runtime verdict), and a commit verdict gates the merge only`,
    );
  });

  it('proves it by a runtime pass at the build, however it was corroborated', () => {
    const [c] = onDev(issue([[verdict('pass', '10:00'), runtime('11:00')]]));
    expect(c).toMatchObject({
      standing: 'pass',
      proven: true,
      unverified: null,
      identity: `runtime ${BUILD.slice(0, 12)} on dev`,
    });
  });

  it("counts no runtime pass at another build, nor the builder's own", () => {
    expect(onDev(issue([[runtime('11:00', EARLIER)]]))[0]?.proven).toBe(false);
    // recorded after the builder-pass cutover, which no amnesty counts
    const after = { byBuilder: true, recordedAt: '2026-10-27T11:00:00.000Z' };
    const [own] = onDev(issue([[runtime('11:00', BUILD, after)]]));
    expect(own?.proven).toBe(false);
    expect(own?.unverified).toBe(BUILDER_WHY);
  });

  it('reads a runtime fail at the build as failing', () => {
    const [c] = onDev(issue([[runtime('11:00', BUILD, { verdict: 'fail' })]]));
    expect(c).toMatchObject({ standing: 'fail', proven: false });
  });

  it('counts a commit verdict on a project naming none, as before (BC-20)', () => {
    expect(read(issue([[verdict('pass', '10:00')]]))[0]?.proven).toBe(true);
    expect(read(issue([[runtime('11:00')]]))[0]?.proven).toBe(false);
  });

  it('asks the approver for a deploy to the environment and a pass there', () => {
    const answers = approvalAnswersOf({
      carried: [],
      unproven: [{ issue: 'ISS-1', n: 1, standing: 'Not judged on dev' }],
      verdictsRequired: true,
      judgedOn: 'dev',
    });
    expect(answers.verdicts).toMatchObject({
      gap: 'Not proven: ISS-1 criterion 1 (Not judged on dev).',
      fix: "Deploy the commit it ships to dev, and have the project's judge pass each there, on the build dev serves.",
    });
  });
});
