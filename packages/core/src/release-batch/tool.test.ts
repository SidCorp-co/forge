import type { ReleaseCutView, ReleaseDetail } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { refusalSays } from './release-cuts.js';
import { releaseToolView } from './tool.js';

// "why was 0.4.0 cancelled" on HOP (journey walk F5): the reason lives on the attempt that wore 0.4.0,
// and the assistant's release read must carry it — the refusal, its meaning, the abort reason, what
// carries it and the roster that attempt was cut with — or the question cannot be answered from data.

const NOT_VERIFIED_040 =
  'what Autoflow serves does not carry 1 landing(s) of this release: ISS-54 landed workflow `193` (`hop_referral`) at draft `999dcf6d`, and Autoflow publishes no version of workflow `193` (`hop_referral`): nothing of it is live';
const ABORT_040 =
  "finish refused RELEASE_NOT_VERIFIED: ISS-54's change record lists workflow 193 (hop_referral) @999dcf6d as a landing, because its shared access block was edited there, and 193 has never been published.";

function cut(over: Partial<ReleaseCutView> & Pick<ReleaseCutView, 'n' | 'version' | 'outcome'>) {
  return {
    runId: `run-${over.n}`,
    cutAt: '2026-10-07T20:00:00.000Z',
    cutBy: null,
    endedAt: null,
    refusal: null,
    abortReason: null,
    decidedBy: null,
    rule: { decided: 'unrecorded', from: null, carriers: [], line: null, taken: false },
    carried: null,
    roster: [
      { key: 'ISS-54', title: 'Referral' },
      { key: 'ISS-102', title: 'Report' },
    ],
    ...over,
  } as ReleaseCutView;
}

const hop040 = {
  version: '0.4.0',
  state: 'aborted',
  releasedAt: null,
  continuedAs: { version: '0.5.0', shipped: true },
  headline: '',
  verified: null,
  verifiedBy: null,
  notes: { sections: [], designs: [], withoutNotes: [] },
  requirementsCompleted: [],
  issues: [],
  feedbackAnswered: [],
  gates: [],
  approval: null,
  waitingOn: null,
  cuts: [
    cut({ n: 1, version: '0.3.0', outcome: 'aborted' }),
    cut({
      n: 2,
      version: '0.4.0',
      outcome: 'aborted',
      refusal: {
        code: 'RELEASE_NOT_VERIFIED',
        text: NOT_VERIFIED_040,
        says: refusalSays('RELEASE_NOT_VERIFIED'),
      },
      abortReason: ABORT_040,
      carried: [],
    }),
    cut({ n: 3, version: '0.5.0', outcome: 'shipped' }),
  ],
} as unknown as ReleaseDetail;

describe('forge_release on a cancelled version', () => {
  const view = releaseToolView(hop040);

  it('names the refusal that ended the attempt wearing it, and the issue it names', () => {
    expect(view.attempt?.refusal?.code).toBe('RELEASE_NOT_VERIFIED');
    expect(view.attempt?.refusal?.text).toContain('ISS-54');
    expect(view.attempt?.refusal?.meaning).toMatch(/could not be proven/);
  });

  it('carries the abort reason, what carries the version, its roster, and where the roster went on', () => {
    expect(view.attempt?.abortReason).toContain('ISS-54');
    expect(view.attempt?.carried).toEqual([]);
    expect(view.attempt?.roster).toEqual(['ISS-54', 'ISS-102']);
    expect(view.continuedAs).toEqual({ version: '0.5.0', shipped: true });
  });

  it('lists every attempt, first first', () => {
    expect(view.attempts.map((a) => [a.version, a.outcome])).toEqual([
      ['0.3.0', 'aborted'],
      ['0.4.0', 'aborted'],
      ['0.5.0', 'shipped'],
    ]);
  });

  it('says a code it has no sentence for by the code, never silently', () => {
    expect(refusalSays('RELEASE_SOMETHING_NEW')).toEqual({
      key: 'releases.refused.other',
      vars: { code: 'RELEASE_SOMETHING_NEW' },
    });
  });
});
