/**
 * ISS-1090: catalog-api 0.6.0, an accepted change-request release, read "Master · merge the requests
 * in order" while only its owner merges dev into release/production on the host. A project that says
 * a person merges its requests (`release.mergedBy: person`) reads the merges as that person's.
 *
 * @direct-test-of packages/core/src/release-batch/release-view.ts
 */
import { whoOwes } from '@forge/contracts/who-owes';
import { describe, expect, it } from 'vitest';
import { releaseOwesOf } from './release-owes.js';
import { turnOf } from './release-view.js';

const POLICY = (mergesByPerson: boolean) => ({
  strict: false,
  gates: {
    agree: false,
    revisions: false,
    breakdown: false,
    admit: false,
    accept: false,
    designs: false,
    triage: false,
  },
  releaseApproval: true,
  ...(mergesByPerson ? { releaseMergesByPerson: true } : {}),
});

const accepted = (mergesByPerson: boolean, viewer: 'owner' | 'agent' | null = null) =>
  turnOf({
    state: 'in_progress',
    version: '0.6.0',
    projectId: 'p1',
    runId: 'r1',
    merges: 2,
    landedOn: null,
    required: true,
    approval: null,
    approvers: [{ id: 'o', name: 'Owner', kind: 'human' }],
    admins: ['Owner'],
    owes: releaseOwesOf(POLICY(mergesByPerson), [], true),
    viewer:
      viewer === null
        ? null
        : {
            userId: viewer,
            agency: viewer === 'owner' ? 'human' : 'agent',
            isAdmin: viewer === 'owner',
            mayApprove: true,
          },
    gates: [],
    inFlight: null,
    testing: null,
  });

describe("an accepted change-request release's merges", () => {
  it('wait on the master where the project says nothing of who merges them (REQ-71 BC-4)', () => {
    expect(accepted(false).waitingOn).toMatchObject({
      kind: 'agent',
      act: 'merge the requests in order',
    });
  });

  it('wait on the approvers, never the master, where a person merges them on the host', () => {
    const turn = accepted(true);
    expect(turn.waitingOn).toMatchObject({ kind: 'person', act: 'merge the requests in order' });
    expect(turn.waitingOn.who).toContain('Owner');
    expect(turn.waitingOn.rule).toContain('a person merges its 2 requests on the host');
    // the owner reading it is named as who acts; an agent holding releases.approve is not
    expect(accepted(true, 'owner').waitingOn).toMatchObject({ kind: 'you' });
    expect(accepted(true, 'agent').waitingOn).toMatchObject({ kind: 'person' });
  });

  it('are the master’s by the one rule unless the switch is on, which names itself', () => {
    expect(whoOwes('release.merge', POLICY(false)).by).toBe('master');
    expect(whoOwes('release.merge', POLICY(true))).toMatchObject({
      by: 'person',
      because: 'policy',
      on: 'release_merges',
    });
  });
});
