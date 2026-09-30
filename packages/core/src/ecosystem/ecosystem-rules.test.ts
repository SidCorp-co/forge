import { describe, expect, it } from 'vitest';
import { example } from './ecosystem.fixture.js';
import { checkEcosystem, type EcosystemWorld } from './ecosystem-rules.js';
import type { EcosystemDocument } from './schema.js';

const doc = () => example('forge-platform.ecosystem.json') as EcosystemDocument;

const world = (over: Partial<EcosystemWorld> = {}): EcosystemWorld => ({
  current: doc(),
  slugHeldBy: null,
  codeHeldBy: null,
  numbersReserved: false,
  memberCommitments: [],
  ...over,
});

const codes = (d: EcosystemDocument, w: EcosystemWorld) =>
  checkEcosystem(d, w).map((r) => `${r.code} ${r.path}`);

describe('an ecosystem write is refused by the rule it breaks', () => {
  it('writes the example as it stands', () => {
    expect(codes(doc(), world())).toEqual([]);
  });

  it('refuses a slug another ecosystem holds', () => {
    expect(codes(doc(), world({ slugHeldBy: 'other' }))).toEqual([
      'ECOSYSTEM_SLUG_TAKEN /ecosystem/slug',
    ]);
  });

  it('refuses a channel code another ecosystem holds', () => {
    expect(codes(doc(), world({ codeHeldBy: 'other' }))).toEqual([
      'CHANNEL_CODE_TAKEN /channel/code',
    ]);
  });

  it('refuses renaming the channel code once a number is reserved', () => {
    const d = doc();
    d.channel.code = 'FPX';
    expect(codes(d, world({ numbersReserved: true }))).toEqual([
      'CHANNEL_CODE_IN_USE /channel/code',
    ]);
  });

  it('renames the channel code while no number is reserved', () => {
    const d = doc();
    d.channel.code = 'FPX';
    expect(codes(d, world())).toEqual([]);
  });

  it('keeps the code, reserved numbers or not, when it does not change', () => {
    expect(codes(doc(), world({ numbersReserved: true }))).toEqual([]);
  });

  it('refuses a window shorter than an active member already promises, naming the member', () => {
    const d = doc();
    d.channel.responseDays.rfi = 2;
    const w = world({
      memberCommitments: [
        { projectSlug: 'forge-plugin', responseDays: { rfi: 3, 'change-request': 7 } },
      ],
    });
    const [refusal, ...rest] = checkEcosystem(d, w);
    expect(rest).toEqual([]);
    expect(refusal).toMatchObject({
      code: 'RESPONSE_WINDOW_EXCEEDS_ECOSYSTEM',
      path: '/channel/responseDays/rfi',
    });
    expect(refusal?.detail).toContain('forge-plugin (3)');
  });
});
