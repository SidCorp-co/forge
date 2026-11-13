// JU-8: hop's 0.3.0 draft read 'Stuck · Release gate · a release is running' while 0.2.0 ran
// normally. A draft held by nothing but the release already running is queued behind it, named by
// that release's version; any other reason beside it keeps the gated turn.

import { describe, expect, it } from 'vitest';
import { blocker } from './blocker-kit.js';
import { gateViews } from './release-gates.js';
import { releaseOwesOf } from './release-owes.js';
import { turnOf } from './release-view.js';

const POLICY = (strict: boolean) => ({
  strict,
  gates: {
    agree: false,
    revisions: false,
    breakdown: false,
    admit: false,
    accept: false,
    designs: false,
    triage: true,
  },
  releaseApproval: false,
});

// `masterCuts` true reads a project that turned no person's gate on, false a strict one (ISS-1058)
const draftTurn = (blockers: ReturnType<typeof blocker>[], masterCuts = false) =>
  turnOf({
    state: 'draft',
    version: '0.3.0',
    projectId: 'p1',
    runId: null,
    merges: null,
    landedOn: null,
    required: false,
    approval: null,
    approvers: [],
    admins: ['Ada'],
    owes: releaseOwesOf(POLICY(!masterCuts), []),
    viewer: { userId: 'u', agency: 'human', isAdmin: true, mayApprove: true },
    gates: gateViews(blockers, [], ['Ada'], releaseOwesOf(POLICY(!masterCuts), [])),
    inFlight: null,
    testing: null,
  });

describe('a draft while another release runs', () => {
  it('is queued behind the running release, not stuck', () => {
    const turn = draftTurn([blocker('BATCH_IN_FLIGHT', { runId: 'r1', version: '0.2.0' })]);
    expect(turn.attentionGroup).toBe('queued');
    expect(turn.waitingOn).toMatchObject({
      kind: 'system',
      who: 'Release run',
      act: 'queued behind 0.2.0',
      rule: 'the release already running finishes before 0.3.0 can be cut',
    });
  });

  it('keeps the gated turn where another reason holds it too', () => {
    const turn = draftTurn([
      blocker('NO_RUNNER_ONLINE'),
      blocker('BATCH_IN_FLIGHT', { runId: 'r1', version: '0.2.0' }),
    ]);
    // the admin's act is no decision, so it waits on them off Needs you (REQ-48 BC-11), not queued
    expect(turn.attentionGroup).toBe('waiting');
    expect(turn.waitingOn.kind).toBe('you');
    expect(turn.waitingOn.act).toBe('bring a runner online and 1 more');
  });

  it('names no version where the running release carries none', () => {
    const turn = draftTurn([blocker('BATCH_IN_FLIGHT', { runId: 'r1', version: null })]);
    expect(turn.attentionGroup).toBe('queued');
    expect(turn.waitingOn.act).toBe('a release is running');
  });
});

// ISS-1043: the page said "an admin cuts the version" while Needs you, REQ-79 r6 BC-11, the steward
// and a room's release read left the cut to the master. The page is now the one answer they all read.
describe('a draft no gate holds', () => {
  it("waits on the project's master to cut it where the master takes the cut, even for an admin viewing", () => {
    const turn = draftTurn([], true);
    expect(turn.attentionGroup).toBe('waiting');
    expect(turn.waitingOn).toMatchObject({
      kind: 'agent',
      who: 'Master',
      act: 'cut 0.3.0',
      // the door named: the master guessed a cut route of the release's own (ISS-1232)
      rule: 'merged issues wait at the release gate; the master cuts with POST /api/projects/p1/release-batches',
    });
  });

  it("is an admin's decision where the master does not take the cut", () => {
    const turn = draftTurn([]);
    expect(turn.attentionGroup).toBe('needs_you');
    expect(turn.waitingOn).toMatchObject({
      kind: 'you',
      act: 'cut 0.3.0',
      rule: 'merged issues wait at the release gate; an admin cuts the version',
    });
  });

  it('keeps a gate before the cut, whoever cuts', () => {
    const turn = draftTurn([blocker('NO_RUNNER_ONLINE')], true);
    expect(turn.waitingOn.act).toBe('bring a runner online');
  });
});

// ISS-1096: sidpeak 0.24.0 read "the release run is working on production" while its production
// deploy waited on a person's confirm, so its job aborted it. The wait is the confirmer's, and the
// approval says beforehand that the confirm will be needed.
describe('a release whose production deploy is kept on request', () => {
  const facts = (over: Partial<Parameters<typeof turnOf>[0]>) =>
    turnOf({
      state: 'in_progress',
      version: '0.24.0',
      projectId: 'p1',
      runId: 'r1',
      merges: null,
      landedOn: null,
      required: true,
      approval: {
        decision: 'approved',
        requestedBy: { id: 'm', name: 'master', kind: 'agent' },
        reason: null,
        decidedBy: { id: 'a', name: 'Ada', kind: 'human' },
      },
      approvers: [{ id: 'a', name: 'Ada', kind: 'human' }],
      admins: ['Bo', 'Ada'],
      owes: releaseOwesOf(POLICY(true), []),
      viewer: { userId: 'm', agency: 'agent', isAdmin: true, mayApprove: true },
      gates: [],
      inFlight: null,
      testing: null,
      prodConfirm: { bindingId: 'b1' },
      confirmsProduction: true,
      ...over,
    });

  it('waits on the approver who may press the confirm, naming the act and its door', () => {
    const turn = facts({});
    expect(turn.attentionGroup).toBe('waiting');
    expect(turn.waitingOn).toMatchObject({
      kind: 'person',
      who: 'Ada',
      act: 'confirm the production deploy of 0.24.0',
    });
    expect(turn.waitingOn.rule).toContain(
      'POST /api/projects/p1/integrations/b1/confirm-prod-deploy',
    );
  });

  it('is stuck naming the permission where nobody holds project.admin', () => {
    const turn = facts({ admins: [] });
    expect(turn.attentionGroup).toBe('stuck');
    expect(turn.waitingOn.kind).toBe('none');
  });

  it('reads as the release run working once nothing waits on a confirm', () => {
    expect(facts({ prodConfirm: null }).waitingOn.who).toBe('Release run');
  });

  it('says on the approval that the confirm will be needed after it', () => {
    const turn = facts({
      state: 'awaiting_approval',
      approval: {
        decision: null,
        requestedBy: { id: 'm', name: 'master', kind: 'agent' },
        reason: null,
      },
      prodConfirm: null,
    });
    expect(turn.waitingOn.effect).toBe(
      "Its production deploy then waits on a project admin's confirm.",
    );
    expect(facts({ state: 'awaiting_approval', confirmsProduction: false }).waitingOn.effect).toBe(
      undefined,
    );
  });
});
