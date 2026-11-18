import { say } from '@forge/contracts/said';
import { holdersWho, waitingOn } from '@forge/contracts/standing';
import { describe, expect, it } from 'vitest';
import type { CarryingRelease } from './dependents.js';
import { type Linked, summaryOf } from './list-read.js';
import type { Row } from './read.js';
import { NONE_UNTOLD } from './ship-notice.js';
import type { ViewerCan } from './viewer-can.js';

// ISS-1295 (gwork FB-89, FB-92, FB-94, FB-95): four items read "cut the release that carries
// ISS-157…", rule "waits at awaiting_release", after their carriers closed and 0.28.0 was cut carrying
// them, awaiting approval. The item waits on that release's act now, as its own page says it, and a
// closed carrier is never said to stand at awaiting_release. Planted red by dropping the release-run
// fact (`carrierRun`) from `list-read.ts:ownStandingIn`: the cut came back.

const AT = new Date('2026-11-17T20:00:00Z');
const ITEM = 'fb-89';

/** Release 0.28.0 awaiting its approval, as `release-view.ts:approvalTurn` reads it with no viewer. */
const AWAITING_APPROVAL: CarryingRelease = {
  version: '0.28.0',
  state: 'awaiting_approval',
  waitingOn: waitingOn('person', {
    who: holdersWho(['Ada']),
    act: say('standing.act.approve'),
    rule: say('releases.rule.asked', { name: 'Master' }),
  }),
};

const row = {
  id: ITEM,
  fbSeq: 89,
  title: 'Exports drop their filters',
  writtenLang: 'en',
  kind: 'bug',
  severity: 'medium',
  status: 'triaged',
  route: 'issue',
  reportedBy: 'reporter',
  reporterAgency: 'agent',
  duplicateOf: null,
  routedSuggestionId: null,
  routedRequirementId: null,
  snoozedUntil: null,
  snoozeReason: null,
  violatedCriterionId: null,
  requirementId: null,
  issueId: null,
  releaseRunId: null,
  workflowId: null,
  contractVersion: null,
  endpointElement: null,
  mockupId: null,
  whereSeen: 'route GET /api/exports',
  redactedAt: null,
  dueAt: null,
  createdAt: AT,
  updatedAt: AT,
} as unknown as Row;

const carrier = (status: string) => ({
  key: 'ISS-157',
  title: 'Keep export filters',
  status,
  releaseVersion: '0.28.0',
  unreleased: status === 'closed',
  failing: [],
  owed: [],
});

const linked = (status: string, runs: ReadonlyMap<string, CarryingRelease>) =>
  ({
    masterTriages: false,
    runnerBound: true,
    masterVerifies: true,
    release: 'manual',
    releaseHolders: ['Ada'],
    releaseCut: { by: 'master', why: 'cutting a release is delivery' },
    carryingRuns: runs,
    issues: new Map([['i-157', carrier(status)]]),
    routeIssues: new Map([[ITEM, ['i-157']]]),
    carrierStandings: new Map(),
    requirements: new Map(),
    releases: new Map(),
    workflows: new Map(),
    providers: new Map(),
    suggestions: new Map(),
    roots: new Map([[ITEM, row]]),
    names: new Map([['reporter', 'gwork']]),
    decidedAt: new Map([[ITEM, AT]]),
    master: 'serves',
    verifyWindowDays: 7,
    untold: NONE_UNTOLD,
    origins: { views: new Map(), fromArchived: new Set() },
  }) as unknown as Linked;

const can: ViewerCan = {
  canTriage: true,
  canRoute: true,
  routeAsks: 'feedback.approve',
  canApproveRelease: true,
  canWrite: true,
  canAdmin: true,
} as unknown as ViewerCan;

const standingOf = (status: string, runs: ReadonlyMap<string, CarryingRelease>) =>
  summaryOf(row, linked(status, runs), { userId: 'admin' } as never, false, can, AT).waitingOn;

describe('an item whose carriers a cut release carries waits on that release, never its cut (ISS-1295)', () => {
  it('reads the approval of the version a manual-release carrier was cut into, by its approver', () => {
    const w = standingOf('closed', new Map([['i-157', AWAITING_APPROVAL]]));
    expect(w).toMatchObject({ kind: 'person', who: 'Ada', ref: '0.28.0' });
    expect(w.act).toBe('approve on release 0.28.0');
    expect(w.rule).toBe(
      'release 0.28.0 carries ISS-157 and waits because Master asked; a holder of releases.approve approves or returns it',
    );
    expect(`${w.act} ${w.rule}`).not.toMatch(/\bcut\b|awaiting_release/);
  });

  it('still reads the cut where no release run carries the carrier', () => {
    const w = standingOf('awaiting_release', new Map());
    expect(w.act).toBe('cut the release that carries ISS-157');
    expect(w.who).toBe("The project's master");
  });

  it('never says a closed carrier waits at awaiting_release, cut or not', () => {
    const w = standingOf('closed', new Map());
    expect(w.act).toBe('cut the release that carries ISS-157');
    expect(w.rule).not.toContain('awaiting_release');
    expect(w.rule).toContain('ISS-157 waits for a release');
  });
});
