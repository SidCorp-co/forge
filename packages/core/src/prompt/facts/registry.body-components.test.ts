import { describe, expect, it } from 'vitest';
import { COMPONENT_NAMES, ROOT_COMPONENT_NAMES } from '../../body/components.js';
import type { JobType } from '../../db/schema.js';
import { getFact } from './registry.js';

describe('body-components (ISS-968)', () => {
  const fact = getFact('body-components');

  it('is contextual, so it never enters the byte-pinned preamble', () => {
    expect(fact?.tier).toBe('contextual');
    expect(fact?.scope).toBe('global');
  });

  it('reaches the driver as well as every staged issue stage', () => {
    expect(fact?.appliesTo).toContain('drive');
    expect(fact?.appliesTo).toContain('review');
    expect(fact?.appliesTo).not.toContain('pm');
  });

  // cm:guard read the two lists back as SETS, never with `toContain` per name: every slot name also appears inside the root that declares it, so a substring assertion stays green while an entry is missing from its own list — measured, on a `.slice(1)` planted for exactly that.
  it('lists every component in the registry, roots and slots each in their own list', () => {
    const text = fact?.render() ?? '';
    const listed = (label: string) =>
      (new RegExp(`^${label} — (.+)$`, 'm').exec(text)?.[1] ?? '')
        .split(' · ')
        .map((entry) => entry.split(' ')[0])
        .sort();
    const slotNames = COMPONENT_NAMES.filter((n) => !ROOT_COMPONENT_NAMES.includes(n));
    expect(listed('Roots')).toEqual([...ROOT_COMPONENT_NAMES].sort());
    expect(listed('Slots')).toEqual([...slotNames].sort());
  });

  it('marks a required slot, a repeatable slot and an enum attribute', () => {
    const text = fact?.render() ?? '';
    expect(text).toContain('forge-summary!');
    expect(text).toContain('forge-finding*');
    expect(text).toContain('verdict=approve|request-changes|abstain');
  });

  it('says prose stays valid, because this phase changes what agents write and not what the kernel accepts', () => {
    expect(fact?.render()).toContain('plain prose stays valid');
  });

  it.each(['triage', 'clarify', 'plan', 'code', 'fix', 'review', 'test', 'release', 'drive'])(
    'names a real root component for the %s step',
    (stage) => {
      const text = fact?.render({ stage: stage as JobType }) ?? '';
      const match = /record comment for this step is a `<([a-z-]+)>`/.exec(text);
      expect(match).not.toBeNull();
      expect(ROOT_COMPONENT_NAMES).toContain(match?.[1]);
    },
  );

  it('falls back to a usable line for a stage with no root of its own', () => {
    expect(fact?.render({ stage: 'custom' })).toContain('Pick the root that matches');
  });
});
