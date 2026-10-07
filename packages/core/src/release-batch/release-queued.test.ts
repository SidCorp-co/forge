// JU-8: hop's 0.3.0 draft read 'Stuck · Release gate · a release is running' while 0.2.0 ran
// normally. A draft held by nothing but the release already running is queued behind it, named by
// that release's version; any other reason beside it keeps the gated turn.

import { describe, expect, it } from 'vitest';
import { blocker } from './blocker-kit.js';
import { gateViews } from './release-gates.js';
import { turnOf } from './release-view.js';

const draftTurn = (blockers: ReturnType<typeof blocker>[]) =>
  turnOf({
    state: 'draft',
    version: '0.3.0',
    approval: null,
    approvers: [],
    viewer: { userId: 'u', agency: 'human', isAdmin: true, mayApprove: true },
    gates: gateViews(blockers, []),
    inFlight: null,
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
    expect(turn.attentionGroup).toBe('needs_you');
    expect(turn.waitingOn.act).toBe('bring a runner online and 1 more');
  });

  it('names no version where the running release carries none', () => {
    const turn = draftTurn([blocker('BATCH_IN_FLIGHT', { runId: 'r1', version: null })]);
    expect(turn.attentionGroup).toBe('queued');
    expect(turn.waitingOn.act).toBe('a release is running');
  });
});
