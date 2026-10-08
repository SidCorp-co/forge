// The probes a release reads, folded across its live bindings (ISS-1282). Pure: `channel.ts` is
// imported with its database and knowledge seams stubbed, and nothing here is read from either.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../knowledge/service.js', () => ({ getKnowledgeEntry: async () => null }));

const { closeVerification, declaredProbesOf, probesOf } = await import('./channel.js');

describe('declaredProbesOf', () => {
  /** A live channel carrying the probes it declares, in the shape `resolveReleaseChannels` returns. */
  const channelOf = (over: Record<string, unknown> = {}) => ({
    bindingId: 'b1',
    provider: 'coolify',
    label: '',
    instructions: null,
    releaseRunnerLabel: null,
    verify: { probes: [{ url: 'https://one.test/health', commitPath: 'commit' }] },
    verifySource: 'binding',
    rollback: null,
    ...over,
  });

  it('folds every channel probe into one config, keeping declaration order', () => {
    const declared = declaredProbesOf([
      channelOf(),
      channelOf({ verify: { probes: [{ url: 'https://two.test/health' }] } }),
    ] as never);
    expect(declared.cfg?.probes).toEqual([
      { url: 'https://one.test/health', commitPath: 'commit' },
      { url: 'https://two.test/health' },
    ]);
    expect(declared.refused).toBe(0);
  });

  it('asks one probe once where two channels declare the same one', () => {
    const declared = declaredProbesOf([channelOf(), channelOf({ bindingId: 'b2' })] as never);
    expect(declared.cfg?.probes).toHaveLength(1);
  });

  it('keeps two probes apart where only their commitPath differs', () => {
    const declared = declaredProbesOf([
      channelOf(),
      channelOf({ verify: { probes: [{ url: 'https://one.test/health', commitPath: 'sha' }] } }),
    ] as never);
    expect(declared.cfg?.probes).toHaveLength(2);
  });

  it('counts a refused declaration, which is not the same as declaring nothing', () => {
    const none = declaredProbesOf([channelOf({ verify: null, verifySource: 'none' })] as never);
    expect(none).toEqual({ cfg: null, refused: 0 });
    const refused = declaredProbesOf([
      channelOf({ verify: null, verifySource: 'declared-unusable' }),
    ] as never);
    expect(refused).toEqual({ cfg: null, refused: 1 });
  });
});

describe('probesOf (ISS-1282)', () => {
  type Probed = Extract<ReturnType<typeof closeVerification>, { kind: 'probed' }>;
  const channel = (verify: unknown, bindingId = 'b1') => ({
    bindingId,
    verify,
    verifySource: 'binding',
  });

  it('folds the probes of every binding into one config, once each, in declaration order', () => {
    const verification = {
      kind: 'probed',
      unread: [],
      channels: [
        channel({ probes: [{ url: 'https://one.test/health', commitPath: 'commit' }] }),
        channel(
          {
            probes: [
              { url: 'https://one.test/health', commitPath: 'commit' },
              { url: 'https://two.test/health' },
            ],
          },
          'b2',
        ),
      ],
    } as unknown as Probed;
    expect(probesOf(verification).probes).toEqual([
      { url: 'https://one.test/health', commitPath: 'commit' },
      { url: 'https://two.test/health' },
    ]);
  });

  it('refuses a probed verification that holds no probe, rather than reading nothing as healthy', () => {
    expect(() => probesOf({ kind: 'probed', channels: [], unread: [] })).toThrow(
      'a probed verification holds no probe',
    );
  });
});
