import { describe, expect, it } from 'vitest';
import { type Doc, EPS, example, FP, interfaceRefusals } from './ecosystem.fixture.js';

const pif = () => example('forge-plugin.interface.json');
const forge = () => example('forge.interface.json');

const plants: [string, string, string, () => Doc][] = [
  [
    'consume an internal module',
    'REF_NOT_PUBLISHED',
    '/consumes/0/contract',
    () => {
      const d = pif();
      d.consumes[0].contract = 'forge/runner';
      return d;
    },
  ],
  [
    'consume across ecosystems',
    'ECOSYSTEM_NOT_SHARED',
    '/consumes/2/ecosystem',
    () => {
      const d = pif();
      d.consumes.push({
        contract: 'epodsystem/checkout-api',
        ecosystem: FP,
        builtAgainst: '3.2.0',
      });
      return d;
    },
  ],
  [
    'consume in an ecosystem the consumer is not in',
    'ECOSYSTEM_NOT_SHARED',
    '/consumes/2/ecosystem',
    () => {
      const d = pif();
      d.consumes.push({
        contract: 'epodsystem/checkout-api',
        ecosystem: EPS,
        builtAgainst: '3.2.0',
      });
      return d;
    },
  ],
  [
    'publish into a foreign ecosystem',
    'ECOSYSTEM_NOT_MEMBER',
    '/publishes/driver-skill/ecosystems/0',
    () => {
      const d = pif();
      d.publishes['driver-skill'].ecosystems = [EPS];
      return d;
    },
  ],
  [
    'consume its own contract',
    'SELF_CONSUMPTION',
    '/consumes/2/contract',
    () => {
      const d = pif();
      d.consumes.push({
        contract: 'forge-plugin/driver-skill',
        ecosystem: FP,
        builtAgainst: '2026-09-28',
      });
      return d;
    },
  ],
  [
    'built against a version never recorded',
    'VERSION_UNKNOWN',
    '/consumes/0/builtAgainst',
    () => {
      const d = pif();
      d.consumes[0].builtAgainst = '2025-01-01';
      return d;
    },
  ],
  [
    'promise slower than the ecosystem allows',
    'RESPONSE_WINDOW_EXCEEDS_ECOSYSTEM',
    '/commitments/responseDays/rfi',
    () => {
      const d = pif();
      d.commitments.responseDays.rfi = 30;
      return d;
    },
  ],
  [
    'a provider slug no project has',
    'REF_UNRESOLVED',
    '/consumes/0/contract',
    () => {
      const d = pif();
      d.consumes[0].contract = 'nobody/forge-api';
      return d;
    },
  ],
  [
    'the same contract twice in one ecosystem',
    'CONSUMPTION_DUPLICATE',
    '/consumes/2',
    () => {
      const d = pif();
      d.consumes.push({ ...d.consumes[0], builtAgainst: '2026-10-01' });
      return d;
    },
  ],
];

describe('an interface write is refused by the rule it breaks, and by that rule alone', () => {
  it.each(plants)('%s -> %s', (_name, code, path, build) => {
    const refusals = interfaceRefusals(build());
    expect(refusals.map((r) => `${r.code} ${r.path}`)).toEqual([`${code} ${path}`]);
  });

  it.each([
    'forge.interface.json',
    'forge-plugin.interface.json',
    'epodsystem.interface.json',
    'store-a.interface.json',
  ])('%s breaks none', (file) => {
    expect(interfaceRefusals(example(file))).toEqual([]);
  });

  it('holds a promise equal to the ecosystem window, which is the boundary', () => {
    const d = pif();
    d.commitments.responseDays.rfi = 5;
    d.commitments.responseDays['change-request'] = 10;
    expect(interfaceRefusals(d)).toEqual([]);
  });
});

describe('a contract with consumers stays published', () => {
  const consumer = [
    {
      consumer: { id: '8f4c3d6b-ae5a-4b1d-8243-5d6e7f8091a3', slug: 'forge-plugin' },
      contractSlug: 'forge-api',
      ecosystemId: FP,
    },
  ];

  it('refuses dropping it, naming the consumer', () => {
    const d = forge();
    delete d.publishes['forge-api'];
    const [refusal, ...rest] = interfaceRefusals(d, consumer);
    expect(rest).toEqual([]);
    expect(refusal).toMatchObject({ code: 'CONTRACT_IN_USE', path: '/publishes/forge-api' });
    expect(refusal?.detail).toContain('forge-plugin');
  });

  it('refuses moving it out of the ecosystem the consumer reads it in', () => {
    const d = forge();
    d.publishes['forge-api'].ecosystems = [EPS];
    expect(interfaceRefusals(d, consumer).map((r) => `${r.code} ${r.path}`)).toEqual([
      'ECOSYSTEM_NOT_MEMBER /publishes/forge-api/ecosystems/0',
      'CONTRACT_IN_USE /publishes/forge-api/ecosystems',
    ]);
  });

  it('lets a contract nobody consumes go', () => {
    const d = forge();
    delete d.publishes['forge-mcp'];
    expect(interfaceRefusals(d, consumer)).toEqual([]);
  });
});
