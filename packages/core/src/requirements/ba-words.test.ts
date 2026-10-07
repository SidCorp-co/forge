// The words a BA reads on Dashboard, Requirements, Releases and Feedback: every act a waiting-on
// cell can show says what the person does in their own terms, never a kernel term (a design slug
// with a revision number, a re-pin, a roster).
import { RELEASE_BLOCKER_CODES } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { feedbackStandingOf, type StandingViewer } from '../feedback/standing.js';
import { gateViews } from '../release-batch/release-gates.js';
import { deriveStanding, type StandingIssue } from './standing.js';

const at = (iso: string) => new Date(iso);
const KERNEL = /re-pin|repin|roster|[a-z]+-[a-z-]+ r\d+\b/i;

const issue = (n: number, status: string): StandingIssue => ({
  id: `i${n}`,
  displayId: `ISS-${n}`,
  title: `Issue ${n}`,
  status,
  tone: 'neutral',
  updatedAt: at('2026-09-20T00:00:00Z'),
  closedAt: null,
  changedSincePlan: false,
});

const base = {
  status: 'agreed' as const,
  owner: { id: 'u1', name: 'Ba', kind: 'human' as const },
  viewer: { userId: 'u1', canSignOff: true },
  revisions: [],
  currentRevision: 3,
  criteria: [],
  issues: [issue(1, 'open')],
  issueCriteria: [],
  openSuggestionKinds: [] as string[],
  stalePins: [] as { flow: string; title: string; pinned: number | null; approved: number }[],
  staleContractPins: [] as { contract: string; pinned: string | null; current: string }[],
  unapprovedDesigns: [] as { flow: string; title: string; designStatus: string | null }[],
  feedback: { open: 0, untriaged: [] as string[] },
  agreedAt: at('2026-09-01T00:00:00Z'),
  updatedAt: at('2026-09-26T00:00:00Z'),
  now: at('2026-09-28T00:00:00Z'),
};

describe('the act a requirement waits on reads in a BA’s words', () => {
  it('asks to update to the approved design by its name and revision, never its slug', () => {
    const s = deriveStanding({
      ...base,
      stalePins: [{ flow: 'order-flow', title: 'Order handling', pinned: 2, approved: 4 }],
    });
    expect(s.waitingOn.act).toBe('Update to the approved design: Order handling (revision 4)');
    expect(s.waitingOn.act).not.toContain('order-flow');
    expect(s.waitingOn.rule).toMatch(/newer approved revision.*re-checks its criteria/s);
    expect(s.waitingOn.act).not.toMatch(KERNEL);
  });

  it('says the same for a person who cannot sign it off', () => {
    const s = deriveStanding({
      ...base,
      viewer: { userId: 'u2', canSignOff: false },
      stalePins: [{ flow: 'order-flow', title: 'Order handling', pinned: null, approved: 1 }],
    });
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn.act).toBe('Update to the approved design: Order handling (revision 1)');
  });

  it('names every design that moved, and a contract, without a kernel term', () => {
    const s = deriveStanding({
      ...base,
      stalePins: [
        { flow: 'a-b', title: 'Alpha', pinned: 1, approved: 2 },
        { flow: 'c-d', title: 'Delta', pinned: 1, approved: 3 },
      ],
      staleContractPins: [{ contract: 'billing/invoices', pinned: '1.0.0', current: '1.1.0' }],
    });
    expect(s.waitingOn.act).toBe(
      'Update to the approved design: Alpha (revision 2); Update to the approved design: Delta (revision 3); Update to the current version of billing/invoices (1.1.0)',
    );
    expect(s.waitingOn.act).not.toMatch(KERNEL);
  });

  it('asks for a review of how the requirement is split into work', () => {
    const s = deriveStanding({ ...base, openSuggestionKinds: ['breakdown'] });
    expect(s.waitingOn.act).toBe('Review how this requirement is split into work');
  });
});

describe('the act a feedback item waits on reads in a BA’s words', () => {
  const viewer = (over: Partial<StandingViewer> = {}): StandingViewer => ({
    isReporter: false,
    canTriage: false,
    canApproveRelease: false,
    canWrite: false,
    ...over,
  });

  it('asks to approve the release by its version, with no issue named in the act', () => {
    const s = feedbackStandingOf('planned', 'issue', ['ISS-9'], 'Reporter', viewer(), null, {
      masterOwesTriage: false,
      carrierRelease: 'approval',
      carrierVersion: '0.4.0-dev.97',
    });
    expect(s.waitingOn.act).toBe('Approve release 0.4.0-dev.97');
    expect(s.waitingOn.ref).toBe('0.4.0-dev.97');
    expect(s.waitingOn.act).not.toMatch(/ISS-/);
  });

  it('asks to confirm the answer, not the fix, on an answered question', () => {
    const s = feedbackStandingOf(
      'resolved',
      'answer',
      [],
      'Reporter',
      viewer({ isReporter: true }),
      null,
    );
    expect(s.waitingOn).toMatchObject({ kind: 'you', act: 'Confirm the answer' });
  });

  it('still asks to verify the fix where a fix resolved it', () => {
    const s = feedbackStandingOf('resolved', 'issue', ['ISS-9'], 'Reporter', viewer(), null);
    expect(s.waitingOn.act).toBe('verify the fix');
  });
});

describe('the release gate speaks in plain words', () => {
  it('names no roster in any reason’s act or sentence', () => {
    const entries = RELEASE_BLOCKER_CODES.map((code) => ({
      code,
      message: 'kernel detail',
      details: {},
    }));
    const views = gateViews(entries as never, []);
    expect(views.length).toBeGreaterThan(5);
    for (const v of views) {
      expect(`${v.owner.act} ${v.sentence} ${v.title}`, v.code).not.toMatch(/roster|in parts/i);
    }
    const oversize = views.find((v) => v.code === 'RELEASE_ROSTER_OVERSIZE');
    expect(oversize?.owner.act).toBe('split this release into smaller releases');
  });
});
