import type { ReleaseContentIssue, ReleaseSummary } from '@forge/contracts/releases';
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { liveChecksLine, liveChecksOf } from './owed-live-checks.js';
import { type MasterJudged, masterVerdict } from './verdict.js';

// ISS-1200: the live verdicts the latest shipped release owes are master work, bounded to the issues
// it closed that nothing judged on production; where no pane can declare their judge, the verdict
// says they wait. The route through the app is `tests/integration/master-owed-live-check-e2e.test.ts`.

const issue = (over: Partial<ReleaseContentIssue>): ReleaseContentIssue => ({
  id: 'i-1',
  key: 'ISS-1',
  title: 'issue',
  status: 'closed',
  proof: 'open',
  changeRequest: null,
  ...over,
});

const release = (state: ReleaseSummary['state'], issues: ReleaseContentIssue[]) =>
  ({
    version: '1.48.0',
    state,
    contents: [{ requirement: null, issues }],
  }) as unknown as ReleaseSummary;

describe('the live verdicts a shipped release owes', () => {
  it('counts only the closed issues a shipped release reads open', () => {
    const owed = liveChecksOf(
      release('shipped', [
        issue({}),
        issue({ id: 'i-2', key: 'ISS-2', proof: 'proven' }),
        issue({ id: 'i-3', key: 'ISS-3', proof: 'failing' }),
        issue({ id: 'i-4', key: 'ISS-4', proof: 'unrecorded' }),
        // reopened after the release: back in work, not waiting on this release's judge
        issue({ id: 'i-5', key: 'ISS-5', status: 'open' }),
      ]),
    );
    expect(owed).toEqual([{ version: '1.48.0', issueId: 'i-1', key: 'ISS-1' }]);
  });

  it('owes nothing where no release shipped to production', () => {
    expect(liveChecksOf(null)).toEqual([]);
    expect(liveChecksOf(release('landed', [issue({})]))).toEqual([]);
  });

  it('names each issue and the release, and says nothing where none is owed', () => {
    expect(liveChecksLine([])).toBe('');
    const line = liveChecksLine(liveChecksOf(release('shipped', [issue({})])));
    expect(line).toContain(
      '1 issue the shipped release 1.48.0 carried owes its live verdict (ISS-1 i-1)',
    );
    expect(line).toContain('`--role qa`');
  });
});

function judged(liveChecks: number, over: Partial<MasterJudged> = {}): MasterJudged {
  return {
    restarting: null,
    terminal: true,
    standing: 'proceed',
    pane: 'alive',
    capability: 'current',
    serversReadable: true,
    work: { admissible: 0, owed: liveChecks, liveChecks, poolWaits: false, jobPanes: 0 },
    conversation: { id: 'conv-1', transcript: 'present', elsewhere: 'none' },
    placement: { placed: { plugins: 'a' }, unreadable: null, now: { plugins: 'b' } },
    holding: { kind: 'nothing' },
    turn: { kind: 'ended' },
    idle: {
      noWorkForSeconds: 0,
      pane: { doing: 'idle', lastEvent: 'stop', lastEventAgoSeconds: 0 },
      children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
    },
    limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
    nudge: { digest: 'd1', last: null, since: 'unreported' },
    ...over,
  };
}

const online = { runnerStatus: 'online', passOpen: false, archivedAt: null };
const WAITS = 'owed live verdict(s) wait on a pane to judge them';

describe('a verdict that leaves no pane to declare the judge names the wait', () => {
  it('a pane kept draining by a working run says the live verdicts wait', () => {
    const v = masterVerdict(
      judged(2, {
        holding: {
          kind: 'these',
          runs: [{ name: 'run-a', subagent: { kind: 'resumed', silentMs: 0 } }],
        },
      }),
      online,
    );
    expect(v).toMatchObject({ act: 'keep', drain: true });
    expect(v.because).toContain(`2 ${WAITS}`);
    expect(saidDisagreements(v)).toEqual([]);
  });

  it('a withheld placement says them too; a pane that can judge them is not told they wait', () => {
    const withheld = masterVerdict(judged(1, { pane: 'absent' }), {
      ...online,
      runnerStatus: 'draining',
    });
    expect(withheld).toMatchObject({ act: 'withhold', reason: 'runner_not_accepting' });
    expect(withheld.because).toContain(`1 ${WAITS}`);
    const replaced = masterVerdict(judged(1), online);
    expect(replaced).toMatchObject({ act: 'replace', reason: 'outdated' });
    expect(replaced.because).not.toContain(WAITS);
    const drained = masterVerdict(judged(0), online);
    expect(drained).toMatchObject({ act: 'keep', drain: true });
    expect(drained.because).not.toContain(WAITS);
  });
});
