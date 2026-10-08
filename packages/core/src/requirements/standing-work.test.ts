import { saidDisagreements, say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import { describe, expect, it } from 'vitest';
import { releaseLegOf } from '../forecast/delivery.js';
import { deriveStanding as deriveStanding_, type StandingIssue } from './standing.js';
import type { ParkedWait } from './standing-work.js';

/** Every sentence the producer said agrees with the English beside it (`saidDisagreements`). */
const checked = <T>(v: T): T => {
  expect(saidDisagreements(v)).toEqual([]);
  return v;
};
const deriveStanding = ((...a: Parameters<typeof deriveStanding_>) =>
  checked(deriveStanding_(...a))) as typeof deriveStanding_;

const at = (iso: string) => new Date(iso);

const issue = (n: number, status: string, changedSincePlan: boolean): StandingIssue => ({
  id: `i${n}`,
  displayId: `ISS-${n}`,
  title: `Issue ${n}`,
  status,
  tone: 'neutral',
  updatedAt: at('2026-09-20T00:00:00Z'),
  closedAt: status === 'closed' ? at('2026-09-21T00:00:00Z') : null,
  changedSincePlan,
  parkedOn: null,
});

const input = (issues: StandingIssue[]) => ({
  status: 'agreed' as const,
  owner: { id: 'u1', name: 'Ba', kind: 'human' as const },
  viewer: null,
  revisions: [
    {
      revision: 3,
      state: 'current' as const,
      authorId: 'u1',
      authorName: 'Ba',
      authorKind: 'human' as const,
      authorAgency: 'human' as const,
      createdAt: at('2026-09-25T00:00:00Z'),
      proposedAt: at('2026-09-25T01:00:00Z'),
      decidedAt: at('2026-09-26T00:00:00Z'),
    },
  ],
  currentRevision: 3,
  criteria: [],
  issues,
  issueCriteria: [],
  openSuggestionKinds: [],
  stalePins: [],
  staleContractPins: [],
  unapprovedDesigns: [] as { flow: string; title: string; designStatus: string | null }[],
  feedback: { open: 0, untriaged: [] },
  judge: 'self' as 'self' | 'independent' | null,
  agreedAt: at('2026-09-01T00:00:00Z'),
  release: null,
  updatedAt: at('2026-09-26T00:00:00Z'),
  now: at('2026-09-28T00:00:00Z'),
});

// ISS-461 round 3: once a requirement's issues exist, its wait names whoever it actually waits on —
// the person owing the release cut once every issue has landed, what a parked issue waits on, and
// its issues only while one of them is being worked.
describe('whom a requirement waits on while its issues are worked', () => {
  const holders = [{ id: 'u9', name: 'Dana Lee', kind: 'human' as const }];
  const approval = releaseLegOf({ mode: 'approval', nextVersion: '0.1.0', lags: [], holders });
  const parked = (n: number, wait: ParkedWait): StandingIssue => ({
    ...issue(n, 'needs_info', false),
    parkedOn: wait,
  });
  const decide = waitingOn('person', {
    who: say('standing.who.named', { name: 'Chuong Le' }),
    act: say('issues.standing.act.decide'),
    rule: say('issues.rule.needsInfo'),
  });
  const landed = [issue(1, 'awaiting_release', false), issue(2, 'awaiting_release', false)];

  it('names the person owing the cut, with the release linked, once every issue not shipped has landed', () => {
    const s = deriveStanding({
      ...input([...landed, issue(3, 'closed', false)]),
      release: approval,
    });
    expect(s.waitingOn).toMatchObject({
      kind: 'person',
      who: 'Dana Lee',
      act: 'cut 0.1.0, then approve it',
      refers: 'release',
      ref: '0.1.0',
    });
    expect(s.waitingOn.rule).toMatch(/^every issue of it not yet shipped has landed \(2\)/);
    // the workflow design's last turn condition groups it moving; only the wait is named (BC-19)
    expect(s.attentionGroup).toBe('moving');
    expect(s.waitingOn.who).not.toBe('Issues');
  });

  it("is the viewer's turn where the viewer owes the cut, and names where the grant is given where nobody holds it", () => {
    const mine = deriveStanding({
      ...input(landed),
      release: releaseLegOf({
        mode: 'manual',
        nextVersion: '0.2.0',
        lags: [],
        holders,
        viewerOwes: true,
      }),
    });
    expect(mine.waitingOn).toMatchObject({
      kind: 'you',
      who: 'You',
      act: 'cut 0.2.0',
      ref: '0.2.0',
    });
    expect(mine.attentionGroup).toBe('needs_you');
    const nobody = deriveStanding({
      ...input(landed),
      release: releaseLegOf({ mode: 'manual', nextVersion: '0.2.0', lags: [], holders: [] }),
    });
    expect(nobody.waitingOn).toMatchObject({ kind: 'person', who: 'Nobody', refers: 'release' });
    expect(nobody.waitingOn.act).toContain('project.admin');
    expect(nobody.attentionGroup).toBe('moving');
  });

  it('waits on the release itself where the project releases on its own', () => {
    const s = deriveStanding({
      ...input(landed),
      release: releaseLegOf({ mode: 'automatic', nextVersion: null, lags: [] }),
    });
    expect(s.waitingOn).toMatchObject({
      kind: 'release',
      who: 'Release',
      refers: 'release',
      ref: null,
    });
    expect(s.attentionGroup).toBe('moving');
  });

  it('refuses by name a landed set whose release the gather did not read', () => {
    expect(() => deriveStanding(input(landed))).toThrow(
      'ISS-1, ISS-2 all await release but the release was not read',
    );
  });

  it('names what a parked issue waits on, its key linked, over issues being worked', () => {
    const s = deriveStanding(
      input([
        parked(1, decide),
        issue(2, 'in_progress', false),
        parked(3, decide),
        issue(4, 'closed', false),
      ]),
    );
    expect(s.waitingOn).toMatchObject({
      kind: 'person',
      who: 'Chuong Le',
      act: 'make a decision on ISS-1',
      refers: 'issue',
      ref: 'ISS-1',
    });
    expect(s.waitingOn.rule).toMatch(/^ISS-1, ISS-3 parked/);
    expect(s.waitingOn.says.act).toEqual(
      say('standing.act.onIssue', { act: decide.says.act, key: 'ISS-1' }),
    );
  });

  it("makes a parked issue the viewer's turn where its own wait is the viewer's", () => {
    const yours = waitingOn('you', {
      who: say('standing.who.you'),
      act: say('issues.standing.act.answer'),
      rule: say('issues.rule.needsInfo'),
    });
    const s = deriveStanding(input([parked(1, yours), issue(2, 'open', false)]));
    expect(s.waitingOn).toMatchObject({
      kind: 'you',
      who: 'You',
      act: 'answer a question on ISS-1',
    });
    expect(s.attentionGroup).toBe('needs_you');
  });

  it('refuses by name a parked issue whose own wait the gather did not read', () => {
    expect(() => deriveStanding(input([issue(1, 'on_hold', false)]))).toThrow(
      'ISS-1 is parked but its own wait was not read',
    );
  });

  it('says its issues only while one is being worked', () => {
    const running = deriveStanding(
      input([issue(1, 'in_progress', false), issue(2, 'awaiting_release', false)]),
    );
    expect(running.waitingOn).toMatchObject({
      kind: 'issue',
      who: 'Issues',
      act: 'Running 1 of 2',
    });
    expect(running.attentionGroup).toBe('moving');
  });

  it('waits on the master to take queued issues, never on "Issues: Shipped 0 of n"', () => {
    const s = deriveStanding(
      input([
        issue(1, 'open', false),
        issue(2, 'awaiting_release', false),
        issue(3, 'approved', false),
        issue(4, 'closed', false),
      ]),
    );
    expect(s.waitingOn).toMatchObject({
      kind: 'agent',
      who: 'Master',
      act: 'take ISS-1, ISS-3 next',
    });
    expect(s.waitingOn.rule).toBe(
      'none of its issues is being worked: ISS-1, ISS-3 wait for the master to take them',
    );
    expect(s.attentionGroup).toBe('moving');
  });

  it('keeps what the wait is about when an untouched requirement reads stuck', () => {
    const s = deriveStanding({
      ...input(landed),
      release: approval,
      now: at('2026-12-31T00:00:00Z'),
    });
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ who: 'Dana Lee', refers: 'release', ref: '0.1.0' });
  });
});
