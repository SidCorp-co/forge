// JU-8: hop's 0.3.0 draft read 'Stuck · Release gate · a release is running' while 0.2.0 ran
// normally. A draft held by nothing but the release already running is queued behind it, named by
// that release's version; any other reason beside it keeps the gated turn.

import { describe, expect, it } from 'vitest';
import { blocker } from './blocker-kit.js';
import { gateViews } from './release-gates.js';
import { turnOf } from './release-view.js';

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
    masterCuts,
    viewer: { userId: 'u', agency: 'human', isAdmin: true, mayApprove: true },
    gates: gateViews(blockers, [], ['Ada']),
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
      rule: "merged issues wait at the release gate; the project's master cuts the version",
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
