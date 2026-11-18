// ISS-1207 (FB-608, adminhub-api 0.19.0, 2026-11-10): its one request !5202 merged, and the release
// still read Master / "merge the requests in order" (n=1), so every master wake asked for a merge
// already made. `turnFor` counted the roster's steps, merged or not; only a request not yet merged
// is one the master owes, and once none is, the release waits on what its settle names.
//
// @direct-test-of packages/core/src/release-batch/release-read-views.ts
// @direct-test-of packages/core/src/release-batch/release-view.ts

import { saidDisagreements } from '@forge/contracts/said';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllIntegrations } from '../integration-registry.js';
import type { ChangeRequestLinkRow } from './change-request-roster.js';
import type { ReleaseFacts } from './release-facts.js';
import { type Part, type Shared, summaryOf } from './release-read-views.js';

const T0 = Date.UTC(2026, 10, 9);

const facts = (n: number): ReleaseFacts => ({
  issues: new Map(
    Array.from({ length: n }, (_, k) => [
      `i${k + 1}`,
      {
        id: `i${k + 1}`,
        key: `ISS-${k + 1}`,
        title: `Issue ${k + 1}`,
        status: 'awaiting_release',
        updatedAt: new Date(T0),
        releaseNotes: null,
        requirementId: null,
        criteria: [],
        classes: new Map(),
        verdicts: new Map(),
        voided: new Map(),
        reopenedAt: null,
        closedAt: [],
        merged: {
          at: new Date(T0),
          landing: null,
          artifacts: null,
          commitSha: null,
          readPaths: null,
        },
      },
    ]),
  ),
  requirements: new Map(),
  cutters: new Map(),
  judge: null,
  judgedOn: null,
  released: null,
  landing: null,
  served: null,
});

const step = (n: number) => ({
  pullRequestId: `pr${n}`,
  host: 'gitlab' as const,
  number: 5200 + n,
  headSha: String(n).repeat(40),
  issueIds: [`i${n}`],
});

const link = (n: number, state: ChangeRequestLinkRow['state']): ChangeRequestLinkRow => ({
  issueId: `i${n}`,
  pullRequestId: `pr${n}`,
  host: 'gitlab',
  number: 5200 + n,
  title: `request ${n}`,
  url: null,
  state,
  updatedAt: new Date(T0),
});

const APPROVED = {
  id: 'a1',
  decision: 'approved' as const,
  requestedAt: new Date(T0).toISOString(),
  decidedAt: new Date(T0).toISOString(),
  requestedBy: { id: 'm1', name: 'Master' },
  decidedBy: { id: 'u1', name: 'chuongld' },
  reason: 'approve 0.19.0',
  evidence: { environment: null, commit: 'c'.repeat(40), reading: 'served' },
  note: null,
  carried: [],
};

/** An accepted change-request release of `n` requests, a promotion's or a plain roster's. */
const accepted = (n: number, promotion: boolean): Part => ({
  version: '0.19.0',
  runId: 'r1',
  state: 'in_progress',
  issueIds: Array.from({ length: n }, (_, k) => `i${k + 1}`),
  openedAt: new Date(T0),
  releasedAt: null,
  attempts: [],
  commit: null,
  approvals: [APPROVED] as unknown as Part['approvals'],
  gates: [],
  verification: null,
  cuts: [],
  continuedAs: null,
  naming: null,
  unapproved: null,
  mergeSteps: Array.from({ length: n }, (_, k) => step(k + 1)),
  landedOn: null,
  shippedFailing: null,
  tag: null,
  draftApproval: null,
  draftDecidable: false,
  runMetadata: promotion
    ? { promotion: { from: 'dev', to: 'production', pullRequestId: 'pr1' } }
    : {},
});

/** The state of each step's request as its own row reads it. */
const states = (...read: Array<[number, ChangeRequestLinkRow['state']]>) =>
  new Map(read.map(([n, state]) => [`pr${n}`, state]));

/** The release as its master reads it, on a project that requires a person's release approval. */
const masterReads = (
  n: number,
  links: ChangeRequestLinkRow[],
  mergeStates: ReadonlyMap<string, ChangeRequestLinkRow['state']>,
): Shared => ({
  projectId: 'p1',
  ownerDeploys: true,
  current: null,
  required: true,
  production: true,
  viewer: { userId: 'm1', agency: 'agent', isAdmin: true, mayApprove: true },
  approvers: [{ id: 'u1', name: 'chuongld', kind: 'human' }],
  admins: ['chuongld'],
  policy: {
    strict: false,
    gates: {
      agree: false,
      revisions: false,
      breakdown: false,
      admit: false,
      accept: false,
      designs: false,
      triage: true,
    },
    releaseApproval: true,
  },
  facts: facts(n),
  contentLanguage: 'en',
  provider: null,
  changeRequestLinks: links,
  mergeStates,
});

const waitingOf = (p: Part, s: Shared) => {
  const summary = summaryOf(p, s);
  expect(saidDisagreements(summary)).toEqual([]);
  return summary.waitingOn;
};

describe('the merges an accepted change-request release still waits on (ISS-1207)', () => {
  // a request's label is its host's (`source-host/resolve.ts`)
  beforeAll(() => registerAllIntegrations());

  it('asks for the merge in order while one of two requests is open, counting only that one', () => {
    const w = waitingOf(
      accepted(2, false),
      masterReads(2, [link(1, 'merged'), link(2, 'open')], states([1, 'merged'], [2, 'open'])),
    );
    expect(w.says.act.key).toBe('standing.act.mergeInOrder');
    expect(w.says.rule).toMatchObject({ vars: { n: 1 } });
  });

  it('counts a step whose request row Forge no longer holds as still owed', () => {
    const w = waitingOf(
      accepted(2, false),
      masterReads(2, [link(1, 'merged')], states([1, 'merged'])),
    );
    expect(w.says.rule).toMatchObject({ vars: { n: 1 } });
  });

  // ISS-1333 (gwork 0.61.0): the promotion merged, and no roster issue links it, so read through the
  // links it stayed "merge the requests in order" (n=1); a step's request row says it merged
  it('reads a merged request no roster issue links as merged, from its own row', () => {
    const w = waitingOf(accepted(1, true), masterReads(1, [], states([1, 'merged'])));
    expect(w.says.act.key).not.toBe('standing.act.mergeInOrder');
    expect(w.says.act.key).toBe('standing.act.recordRelease');
  });

  // ISS-1333: every request merged and an issue holds no mark, the settle waits on that mark, and the
  // release read "release run starting" with no run to start; it names the issue the mark is owed on
  it('names the roster issue holding no merge mark once every request merged', () => {
    const read = masterReads(2, [], states([1, 'merged'], [2, 'merged']));
    const unmarked = read.facts.issues.get('i2');
    if (unmarked) unmarked.merged.at = null;
    const w = waitingOf(accepted(2, false), read);
    expect(w.says.act.key).toBe('standing.act.markRosterMerged');
    expect(w.says.rule).toMatchObject({ vars: { issues: 'ISS-2' } });
    expect(w.says.who.key).toBe('standing.who.master');
  });

  it('asks for no merge once every request merged: a promotion waits on its record, the master’s once approved', () => {
    const w = waitingOf(
      accepted(1, true),
      masterReads(1, [link(1, 'merged')], states([1, 'merged'])),
    );
    expect(w.says.act.key).not.toBe('standing.act.mergeInOrder');
    expect(w.says.act.key).toBe('standing.act.recordRelease');
    expect(w.kind).toBe('agent');
    expect(w.says.who.key).toBe('standing.who.master');
  });
});
