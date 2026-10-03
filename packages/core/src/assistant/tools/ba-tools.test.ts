import { describe, expect, it } from 'vitest';
import { baDoorPersona } from '../door-persona.js';
import { BA_TOOL_NAMES, buildBaToolset } from './ba-tools.js';
import { catalogOnlyContext } from './principal.js';

describe('BA door', () => {
  it('offers exactly its narrow tool set: no requirement, revision or issue write, no forge CLI', () => {
    const ctx = catalogOnlyContext('00000000-0000-4000-8000-000000000001', 'p');
    const names = buildBaToolset(ctx, {
      projectId: '00000000-0000-4000-8000-000000000001',
      requirementId: '00000000-0000-4000-8000-000000000002',
    }).tools.map((t) => t.function.name);
    expect(names).toEqual([...BA_TOOL_NAMES]);
    expect(names.some((n) => /requirement|issue/.test(n) && !n.startsWith('ba_read'))).toBe(false);
  });

  it('composes its persona naming the requirement, without the tracker-method layers', () => {
    const persona = baDoorPersona('Forge', 'REQ-3', 'Lan');
    expect(persona).toContain('requirement REQ-3');
    expect(persona).toContain('ba_suggest');
    expect(persona).not.toContain('forge new');
  });
});
