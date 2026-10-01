import { describe, expect, it } from 'vitest';
import {
  pluginDesignationSchema,
  readPluginDesignations,
  unionPluginDesignations,
} from './designation.js';

const FORGE = { marketplace: 'SidCorp-co/forge-plugin', name: 'forge' };
const SHA = '867ef128a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('readPluginDesignations', () => {
  it('reads a stored list a write door accepted', () => {
    expect(readPluginDesignations({ plugins: [FORGE] }, 'forge-dev')).toEqual([FORGE]);
  });

  it('reads no plugins where the project stores none', () => {
    expect(readPluginDesignations(null, 'forge-dev')).toEqual([]);
    expect(readPluginDesignations({}, 'forge-dev')).toEqual([]);
  });

  it('refuses a stored entry no door accepts by name, rather than reading it as no plugins', () => {
    expect(() =>
      readPluginDesignations({ plugins: [{ ...FORGE, autoUpdate: false }] }, 'forge-dev'),
    ).toThrow(/PLUGIN_DESIGNATIONS_INVALID: project forge-dev .*plugins\.0/);
  });

  it('refuses a list that is not a list', () => {
    expect(() => readPluginDesignations({ plugins: 'forge' }, 'forge-dev')).toThrow(
      'PLUGIN_DESIGNATIONS_INVALID',
    );
  });
});

describe('a designation carries no autoUpdate of its own', () => {
  it('refuses the deleted key on a write', () => {
    expect(pluginDesignationSchema.safeParse({ ...FORGE, autoUpdate: true }).success).toBe(false);
  });

  it('resolves a union with the pin as the only lever', () => {
    const union = unionPluginDesignations([
      { slug: 'a', designations: [FORGE] },
      { slug: 'b', designations: [{ ...FORGE, pinnedRef: SHA }] },
    ]);
    expect(union).toEqual([{ ...FORGE, pinnedRef: SHA, projects: ['a', 'b'] }]);
  });
});
