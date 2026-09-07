import { describe, expect, it } from 'vitest';
import { COMPONENT_NAMES, specFor } from './components.js';
import { type BodyComponentDescriptor, describeRegistry } from './registry-view.js';

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
});
