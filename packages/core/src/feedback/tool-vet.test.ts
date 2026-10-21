// The chat feedback tool's one target, judged before its card is held: on forge-dev (chat a760cd5f,
// 2026-10-21) a gateway model filled all six target fields, or blanked five, on four calls running,
// and each card failed FEEDBACK_TARGET_NOT_ONE only when the owner pressed Record it.

import { describe, expect, it } from 'vitest';
import { FEEDBACK_RECORD_VETS } from './tool.js';

const vet = FEEDBACK_RECORD_VETS.forge_feedback;
const PROJECT = '6f0ee160-8432-4b84-98cf-956b6cd65a29';
const said = (r: unknown) => JSON.stringify(r);

describe('the chat feedback tool, before its card is held', () => {
  it('holds a call naming one target as { kind, ref }', async () => {
    expect(
      await vet({
        projectId: PROJECT,
        kind: 'bug',
        title: 'Record it fails on every card',
        target: { kind: 'requirement', ref: 'REQ-41' },
      }),
    ).toBeNull();
  });

  it('refuses the six target fields the failing cards carried, naming each', async () => {
    const r = said(
      await vet({
        projectId: PROJECT,
        kind: 'change_request',
        title: 'Closing an issue resolves its open questions',
        requirement: 'REQ-41',
        issue: 'ISS-549',
        release: '0.4.0-dev.258',
        workflow: 'Issue lifecycle',
        endpoint: '/api/issues/:id/transition',
        screen: '/projects/forge/issues',
      }),
    );
    expect(r).toContain('Unrecognized keys');
    for (const field of ['requirement', 'issue', 'release', 'workflow', 'endpoint', 'screen']) {
      expect(r).toContain(field);
    }
    expect(r).toContain('/target');
  });

  it('refuses a blank target, as the fifth card sent', async () => {
    const r = said(
      await vet({
        projectId: PROJECT,
        kind: 'bug',
        title: 'x',
        target: { kind: 'issue', ref: ' ' },
      }),
    );
    expect(r).toContain('/target/ref');
  });

  it('refuses a screen target with a whereSeen beside it, which names the screen twice', async () => {
    const r = said(
      await vet({
        projectId: PROJECT,
        kind: 'bug',
        title: 'x',
        whereSeen: 'the issues list',
        target: { kind: 'screen', ref: '/projects/forge/issues' },
      }),
    );
    expect(r).toContain('FEEDBACK_SCREEN_TWICE');
  });
});
