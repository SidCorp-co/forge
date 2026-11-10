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
  judgedOnRelease: [],
  landing: null,
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

/** The release as its master reads it, on a project that requires a person's release approval. */
const masterReads = (n: number, links: ChangeRequestLinkRow[]): Shared => ({
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
    const w = waitingOf(accepted(2, false), masterReads(2, [link(1, 'merged'), link(2, 'open')]));
    expect(w.says.act.key).toBe('standing.act.mergeInOrder');
    expect(w.says.rule).toMatchObject({ vars: { n: 1 } });
  });

  it('counts a request no link reads merged as still owed', () => {
    const w = waitingOf(accepted(2, false), masterReads(2, [link(1, 'merged')]));
    expect(w.says.rule).toMatchObject({ vars: { n: 1 } });
  });

  it('asks for no merge once every request merged: a promotion waits on its record, the master’s once approved', () => {
    const w = waitingOf(accepted(1, true), masterReads(1, [link(1, 'merged')]));
    expect(w.says.act.key).not.toBe('standing.act.mergeInOrder');
    expect(w.says.act.key).toBe('standing.act.recordRelease');
    expect(w.kind).toBe('agent');
    expect(w.says.who.key).toBe('standing.who.master');
  });
});
