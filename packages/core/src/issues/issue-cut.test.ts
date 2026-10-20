import { describe, expect, it } from 'vitest';
import { credentialActor } from './actor-agency.js';
import { runCloseFor } from './issue-cut.js';

/** ISS-1228 round 22 — what an issue's end cuts follows the credential that moved it, whichever door. */
describe('the jobs an issue’s end spares', () => {
  it('spares the jobs on the box a workspace credential names, whoever holds it', () => {
    for (const agency of ['human', 'agent'] as const) {
      const actor = credentialActor({ userId: 'u-1', agency, deviceId: 'box-a' });
      expect(runCloseFor(actor, 'dropped', false)).toEqual([
        'cancelled',
        { cause: 'issue_dropped', spares: { deviceId: 'box-a' } },
      ]);
    }
  });

  it('spares every job where an agent account that names no box moved it', () => {
    const actor = credentialActor({ userId: 'agent-1', agency: 'agent', deviceId: null });
    expect(runCloseFor(actor, 'closed', false)).toEqual([
      'completed',
      { cause: 'issue_closed', spares: 'every' },
    ]);
  });

  it('spares none where a person moved it from no box', () => {
    const actor = credentialActor({ userId: 'u-1', agency: 'human', deviceId: undefined });
    expect(runCloseFor(actor, 'dropped', false)).toEqual([
      'cancelled',
      { cause: 'issue_dropped', spares: 'none' },
    ]);
  });

  it('cuts nothing while the deploy gate holds the close', () => {
    const actor = credentialActor({ userId: 'u-1', agency: 'human', deviceId: null });
    expect(runCloseFor(actor, 'closed', true)).toEqual(['completed', undefined]);
  });
});
