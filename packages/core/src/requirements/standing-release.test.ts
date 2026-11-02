// ISS-900: a verdict judged on a release, on a project whose production names no commit it serves,
// is weighed on the agent's release record alone (`standing-identity.ts:atRelease`), and the standing
// asks for that judgement, or for the record, never for one that cannot count (`releaseAskOf`).
// @direct-test-of packages/core/src/requirements/standing-identity.ts
// @direct-test-of packages/core/src/requirements/standing-proof.ts
// @direct-test-of packages/core/src/requirements/standing.ts
// @direct-test-of packages/core/src/lib/standing-act-class.ts
import { releaseHint } from '@forge/contracts/released-line';
import { say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import { describe, expect, it } from 'vitest';
import { actClassOf } from '../lib/standing-act-class.js';
import { deriveStanding, type LiveBuildHolds, type StandingIssueCriterion } from './standing.js';
import { atRelease, type ReleasedLine } from './standing-identity.js';
import { releaseAskOf } from './standing-proof.js';

const WHY = 'its production `production` declares no source probe';
const at = (day: number) => new Date(Date.UTC(2026, 10, day));

const line = (
  live: string | null,
  shipped: Record<string, boolean> = live ? { [live]: true } : {},
): ReleasedLine => ({
  why: WHY,
  live: live ? { version: live, at: at(2) } : null,
  shipped: new Map(
    Object.entries(shipped).map(([v, carried]) => [v, { at: at(1), carried, carries: [] }]),
  ),
});

describe('a verdict judged on a release', () => {
  it('counts on the release the record says is live', () => {
    expect(atRelease('0.76.0', line('0.76.0'))).toEqual({
      commit: null,
      inLiveBuild: true,
      notCounted: null,
    });
  });

  it('counts on an earlier release the live one carries, saying so', () => {
    const r = atRelease('0.76.0', line('0.77.0', { '0.76.0': true, '0.77.0': true }));
    expect(r.notCounted).toBeNull();
    expect(r.countedAs).toBe('release 0.76.0, carried by live release 0.77.0');
  });

  it('does not count under a release recorded later at a lower version', () => {
    const r = atRelease('0.76.0', line('0.75.1', { '0.76.0': false, '0.75.1': true }));
    expect(r.inLiveBuild).toBe(false);
    expect(r.notCounted).toContain('judge it again on release 0.75.1');
  });

  it('does not count on a version no record shipped, or with none shipped', () => {
    expect(atRelease('0.80.0', line('0.76.0')).notCounted).toContain(
      'which no release this project recorded as shipped names',
    );
    expect(atRelease('0.76.0', line(null)).notCounted).toBe(
      `judged on release 0.76.0, and no release is recorded as shipped: ${WHY}`,
    );
  });

  it('does not count where production reads its commit, which a verdict there names', () => {
    expect(atRelease('0.76.0', undefined)).toMatchObject({ inLiveBuild: null });
    expect(atRelease('0.76.0', undefined).notCounted).toContain('names the commit judged');
  });
});

describe('what the standing asks where a verdict counts only on a release', () => {
  const live = { sha: null, holds: new Map(), runtimes: new Map(), unanswered: new Map() };

  it('names the live release, or none recorded', () => {
    expect(releaseAskOf({ ...live, released: line('0.76.0') })).toEqual({ version: '0.76.0' });
    expect(releaseAskOf({ ...live, released: line(null) })).toBe('none');
    expect(releaseHint(line('0.76.0'), 'requirement')).toContain(
      "{ kind: 'release', version: '0.76.0' }` at the requirement",
    );
    // an issue criterion's verdict is sent to the issue that can carry it, never to the requirement
    expect(releaseHint(line('0.76.0'), 'issue')).toContain(
      "{ kind: 'release', version: '0.76.0' }` on the issue",
    );
  });

  it('asks as before where production reads its commit', () => {
    expect(releaseAskOf(live)).toBeNull();
    expect(releaseAskOf(null)).toBeNull();
    expect(releaseHint(undefined, 'issue')).toBeNull();
  });

  // a promotion project's issues weigh at their landings, where a release verdict counts too
  // (`release-batch/landed-weighing.ts`): the ask is the release once one is recorded, else a commit
  it('asks a promotion project for its live release, or for a commit at the landing before any', () => {
    const promoted = { ...live, landed: new Map(), promoted: true };
    expect(releaseAskOf({ ...promoted, released: line('0.76.0') })).toEqual({ version: '0.76.0' });
    expect(releaseAskOf({ ...promoted, released: line(null) })).toBeNull();
  });
});

describe('the judgement on a release, on the issues that carry it', () => {
  it("is the judge's act", () => {
    const act = say('standing.act.judgeOnReleaseOn', {
      codes: 'BC-1',
      keys: 'ISS-1',
      version: '0.76.0',
    });
    const w = waitingOn('agent', { who: say('standing.who.master'), act, rule: act });
    expect(actClassOf(w)).toBe('judge');
  });
});

// Another project's issue is weighed on its own project's build (`standing-identity.ts:holdsFor`), so
// the judgement it can carry is on its own project's release, never the requirement project's.
describe("another project's issue is asked on its own project's release", () => {
  const nothing = { sha: null, holds: new Map(), runtimes: new Map(), unanswered: new Map() };
  const issue = (n: number) => ({
    id: `i${n}`,
    displayId: `ISS-${n}`,
    title: `Issue ${n}`,
    status: 'closed',
    tone: 'neutral' as const,
    updatedAt: at(1),
    closedAt: at(1),
    changedSincePlan: false,
  });
  const unjudged = (n: number): StandingIssueCriterion => ({
    issueId: `i${n}`,
    n: 1,
    requirementCriterionId: 'c1',
    verdict: null,
    verdictAt: null,
    identity: null,
    byBuilder: false,
    authored: false,
    recordedAt: null,
  });
  /** The requirement project's release 0.78.0; ISS-2 belongs to a project read as `theirs`. */
  const askOn = (traced: number[], theirs: LiveBuildHolds | null) => {
    const liveBuild: LiveBuildHolds = {
      ...nothing,
      released: line('0.78.0'),
      foreign: new Map([['i2', theirs]]),
    };
    // the standing as the requirement page reads it, through `deriveStanding`'s own wiring
    const standing = deriveStanding({
      status: 'agreed',
      owner: { id: 'u1', name: 'Ba', kind: 'human' },
      viewer: null,
      revisions: [
        {
          revision: 1,
          state: 'current',
          authorId: 'u1',
          authorName: 'Ba',
          authorKind: 'human',
          authorAgency: 'human',
          createdAt: at(1),
          proposedAt: at(1),
          decidedAt: at(1),
        },
      ],
      currentRevision: 1,
      criteria: [
        { id: 'c1', code: 'BC-1', body: 'rule 1', sinceRevision: 1, retiredRevision: null },
      ],
      issues: traced.map((n) => ({ ...issue(n), parkedOn: null })),
      issueCriteria: traced.map(unjudged),
      openSuggestionKinds: [],
      stalePins: [],
      staleContractPins: [],
      unapprovedDesigns: [],
      feedback: { open: 0, untriaged: [] },
      judge: 'self',
      agreedAt: at(1),
      release: null,
      updatedAt: at(1),
      statusSince: at(1),
      master: 'serves',
      now: at(3),
      liveBuild,
    });
    return standing.waitingOn.says?.act;
  };

  it("names the issue's own project's live release, not the requirement's", () => {
    expect(askOn([2], { ...nothing, released: line('0.76.0') })).toEqual({
      key: 'standing.act.judgeOnReleaseOn',
      vars: { codes: 'BC-1', keys: 'ISS-2', version: '0.76.0' },
    });
  });

  it('names each release beside the issues judged on it, where the issues span two projects', () => {
    expect(askOn([1, 2], { ...nothing, released: line('0.76.0') })).toEqual({
      key: 'standing.act.judgeOnReleaseOn',
      vars: { codes: 'BC-1', keys: 'ISS-1, ISS-2', version: '0.78.0 (ISS-1), 0.76.0 (ISS-2)' },
    });
  });

  it("asks for a commit where the issue's project reads the commit its production serves", () => {
    expect(askOn([2], null)).toEqual({
      key: 'standing.act.judgeOn',
      vars: { codes: 'BC-1', keys: 'ISS-2' },
    });
  });

  it("asks the master for the record where the issue's project has recorded no release", () => {
    expect(askOn([2], { ...nothing, released: line(null) })).toEqual({
      key: 'standing.act.recordRelease',
    });
  });
});
