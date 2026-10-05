import type { LiveShortfall } from '@forge/contracts/contract-waits';
import { describe, expect, it } from 'vitest';
import { gateReading } from '../ecosystem/contract/waits-live.js';
import { askProviderLiveGate, provideReleaseBatchPorts } from './provider-live.js';

const short = (issueId: string, issue: string): LiveShortfall => ({
  issueId,
  issue,
  contract: 'acme/orders',
  needed: '2.0.0',
  live: '1.4.0',
  unread: null,
});

describe('the provider live gate a release asks (requirement-to-delivery release-gate, E4)', () => {
  it('reads a served version as served, a short one as short, and a short one under an off gate as gate off', () => {
    expect(gateReading({ gate: 'required', live: '2.1.0', needed: '2.0.0' }, 'semver')).toBe(
      'served',
    );
    expect(gateReading({ gate: 'required', live: '1.4.0', needed: '2.0.0' }, 'semver')).toBe(
      'short',
    );
    expect(gateReading({ gate: 'required', live: null, needed: '2.0.0' }, 'semver')).toBe('short');
    expect(gateReading({ gate: 'off', live: '1.4.0', needed: '2.0.0' }, 'semver')).toBe('gate_off');
    expect(gateReading({ gate: 'off', live: '2.0.0', needed: '2.0.0' }, 'semver')).toBe('served');
  });

  it('refuses CONTRACT_PROVIDER_NOT_LIVE once per held issue, pointed at it', async () => {
    provideReleaseBatchPorts({
      contractProviderGate: async () => ({
        shortfalls: [short('b', 'HOP-2'), short('b', 'HOP-2')],
        gateOff: [],
      }),
    });
    const err = await askProviderLiveGate(['a', 'b']).catch((e: unknown) => e);
    const refusals = (err as { refusals: { code: string; path: string; detail: string }[] })
      .refusals;
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe('CONTRACT_PROVIDER_NOT_LIVE');
    expect(refusals[0]?.path).toBe('/issueIds/1');
    expect(refusals[0]?.detail).toContain('`HOP-2` needs acme/orders >= 2.0.0');
  });

  it('lets a release through an off gate and answers what it passed, for the release to record as gate off', async () => {
    provideReleaseBatchPorts({
      contractProviderGate: async () => ({ shortfalls: [], gateOff: [short('a', 'HOP-1')] }),
    });
    await expect(askProviderLiveGate(['a'])).resolves.toEqual([
      { issue: 'HOP-1', contract: 'acme/orders', needed: '2.0.0', live: '1.4.0' },
    ]);
  });
});
