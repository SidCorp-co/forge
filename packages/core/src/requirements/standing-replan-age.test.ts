// The re-plan tasks an impact flag opens, and a requirement's age: the time it has stood in its state,
// never since its last edit (REQ-29 BC-5).
// @direct-test-of packages/core/src/requirements/standing-tasks.ts
// @direct-test-of packages/core/src/requirements/standing-age.ts
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { deriveStanding as deriveStanding_, type StandingIssue } from './standing.js';

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
  statusSince: at('2026-09-26T00:00:00Z'),
  master: 'serves' as const,
  now: at('2026-09-28T00:00:00Z'),
});

// requirement-to-delivery `impact` opens `delivery`: one re-plan task per flagged issue and revision
describe('the re-plan task an impact flag opens', () => {
  it('holds one re-plan task per flagged live issue, at the current revision, owned by the master', () => {
    const s = deriveStanding(
      input([issue(1, 'in_progress', true), issue(2, 'open', false), issue(3, 'open', true)]),
    );
    expect(s.tasks.filter((t) => t.kind === 're-plan')).toEqual([
      {
        kind: 're-plan',
        owner: 'Project master',
        revision: 3,
        openedAt: '2026-09-26T00:00:00.000Z',
        dueAt: null,
        overdue: false,
        issueId: 'i1',
        displayId: 'ISS-1',
      },
      {
        kind: 're-plan',
        owner: 'Project master',
        revision: 3,
        openedAt: '2026-09-26T00:00:00.000Z',
        dueAt: null,
        overdue: false,
        issueId: 'i3',
        displayId: 'ISS-3',
      },
    ]);
    expect(s.waitingOn.act).toBe('re-plan “Issue 1” and “Issue 3”');
  });

  it('opens none for an issue that shipped or was dropped, and none while nothing is flagged', () => {
    const shipped = deriveStanding(
      input([issue(1, 'closed', true), issue(2, 'dropped', true), issue(3, 'open', false)]),
    );
    expect(shipped.tasks.some((t) => t.kind === 're-plan')).toBe(false);
    expect(shipped.waitingOn.act).not.toContain('re-plan');
  });

  it('opens none on a requirement that is not agreed', () => {
    const s = deriveStanding({ ...input([issue(1, 'open', true)]), status: 'accepted' });
    expect(s.tasks).toEqual([]);
  });
});

// REQ-29 BC-5's AGE: time in the state it stands in, never since its last edit (live dev.227, where
// setting area and short name on every requirement read every row "1m")
describe('how long a requirement has stood in its state', () => {
  const since = at('2026-09-10T00:00:00Z');
  const edited = at('2026-09-27T23:59:00Z');

  it('a placement or short-name edit moves its touched time and leaves its state time', () => {
    const s = deriveStanding({ ...input([]), statusSince: since, updatedAt: edited });
    expect(s.state).toBe('agreed');
    expect(s.touchedAt).toBe(edited.toISOString());
    expect(s.stateSince).toBe(since.toISOString());
  });

  it('in delivery, it counts from the move into delivery, not from when an issue started', () => {
    const started = (n: number, iso: string): StandingIssue => ({
      ...issue(n, 'in_progress', false),
      updatedAt: edited,
      startedAt: at(iso),
    });
    const s = deriveStanding({
      ...input([started(1, '2026-09-15T00:00:00Z'), started(2, '2026-09-12T00:00:00Z')]),
      status: 'in_delivery',
      statusSince: since,
    });
    expect(s.state).toBe('in_delivery');
    expect(s.stateSince).toBe(since.toISOString());
  });

  it('a status move after the work started is where it counts from', () => {
    const s = deriveStanding({
      ...input([{ ...issue(1, 'in_progress', false), startedAt: at('2026-09-12T00:00:00Z') }]),
      statusSince: at('2026-09-20T00:00:00Z'),
    });
    expect(s.stateSince).toBe('2026-09-20T00:00:00.000Z');
  });
});
