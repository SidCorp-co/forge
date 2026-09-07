import { describe, expect, it } from 'vitest';
import { COMPONENT_NAMES, specFor } from './components.js';
import {
  type BodyComponentDescriptor,
  describeComponents,
  describeRegistry,
} from './registry-view.js';

const byName = (): Map<string, BodyComponentDescriptor> =>
  new Map(describeRegistry().map((d) => [d.name, d]));

describe('describeRegistry', () => {
  it('covers the registry exactly — no component missing, none invented', () => {
    expect([...byName().keys()].sort()).toEqual([...COMPONENT_NAMES].sort());
  });

  it('reports the same required attributes the write path refuses without', () => {
    const review = byName().get('forge-review');
    const attrs = new Map(review?.attrs.map((a) => [a.name, a]));
    expect(attrs.get('sha')?.required).toBe(true);
    expect(attrs.get('verdict')?.values).toEqual(['approve', 'request-changes', 'abstain']);
  });

  it('marks an optional attribute optional', () => {
    const attrs = new Map(
      byName()
        .get('forge-qa-report')
        ?.attrs.map((a) => [a.name, a]),
    );
    expect(attrs.get('verdict')?.required).toBe(true);
    expect(attrs.get('env')?.required).toBe(false);
  });

  it('separates roots from slots the way `refuseMisplaced` does', () => {
    const map = byName();
    expect(map.get('forge-problem')?.root).toBe(true);
    expect(map.get('forge-finding')?.root).toBe(false);
    expect(map.get('forge-diagram')?.leaf).toBe(true);
    expect(map.get('forge-diagram')?.raw).toBe(true);
    expect(map.get('forge-problem')?.ordered).toBe(true);
  });

  it('carries each declared slot with its key, repeat and required flags', () => {
    const slots = byName().get('forge-review')?.slots ?? [];
    expect(slots).toEqual([
      { component: 'forge-finding', key: 'findings', repeat: true, required: false },
      { component: 'forge-summary', key: 'summary', repeat: false, required: true },
    ]);
  });

  // cm:guard this is the ONLY thing standing between the composer's menu and a second component list. It fails the moment a descriptor stops agreeing with the spec it was derived from — do not relax it to a name check.
  it('derives every field from the spec rather than restating it', () => {
    for (const d of describeRegistry()) {
      const spec = specFor(d.name);
      expect(spec).toBeDefined();
      expect(d.root).toBe(spec?.root);
      expect(d.leaf).toBe(spec?.leaf === true);
      expect(d.raw).toBe(spec?.raw === true);
      expect(d.slots.map((s) => s.component)).toEqual(spec?.slots.map((s) => s.component));
    }
  });

  it('reads an optional enum through its wrapper, not around it', () => {
    const attrs = new Map(
      byName()
        .get('forge-case')
        ?.attrs.map((a) => [a.name, a]),
    );
    expect(attrs.get('id')?.required).toBe(false);
    expect(attrs.get('verdict')).toEqual({
      name: 'verdict',
      required: true,
      values: ['pass', 'fail', 'skip'],
    });
  });
});

// cm:guard the prompt fact and the wire shape are TWO PROJECTIONS OF ONE READING, not two readings. ISS-968 shipped a private zod probe in `components.ts` and ISS-967 a second one here; these hold the survivor honest, because the failure of two probes is not an error but a prompt that promises an attribute the 400 refuses.
describe('describeComponents — the prompt fact', () => {
  it('prints every component the descriptors carry, roots and slots apart', () => {
    const text = describeComponents();
    for (const d of describeRegistry()) {
      expect(text).toContain(d.name);
    }
    const [roots, slots] = text.split('\n');
    expect(roots?.startsWith('Roots — ')).toBe(true);
    expect(slots?.startsWith('Slots — ')).toBe(true);
    expect(roots).toContain('forge-review');
    expect(slots).toContain('forge-finding');
    expect(roots).not.toContain('forge-finding ');
  });

  it('prints each attribute exactly as the descriptor reports it', () => {
    const text = describeComponents();
    expect(text).toContain('forge-review [sha=string verdict=approve|request-changes|abstain]');
    expect(text).toContain('{forge-finding* forge-summary!}');
    expect(text).toContain('env=string?');
  });
});
