// Union + conflict semantics for server-designated plugins.

import { describe, expect, it } from 'vitest';
import {
  mergePluginDesignations,
  pluginDesignationSchema,
  readPluginDesignations,
  unionPluginDesignations,
} from './designation.js';

const MP = 'SidCorp-co/forge-pipeline-skills';

describe('pluginDesignationSchema', () => {
  it('rejects a non-kebab-case plugin name', () => {
    expect(
      pluginDesignationSchema.safeParse({ marketplace: MP, name: 'Forge_CodeMap' }).success,
    ).toBe(false);
  });

  it('rejects a pinnedRef that is not a commit SHA', () => {
    expect(
      pluginDesignationSchema.safeParse({
        marketplace: MP,
        name: 'forge-codemap',
        pinnedRef: 'v0.1.3',
      }).success,
    ).toBe(false);
  });

  it('accepts a minimal designation', () => {
    expect(
      pluginDesignationSchema.safeParse({ marketplace: MP, name: 'forge-codemap' }).success,
    ).toBe(true);
  });
});

describe('readPluginDesignations', () => {
  it('returns [] for absent or malformed config rather than throwing', () => {
    expect(readPluginDesignations(null)).toEqual([]);
    expect(readPluginDesignations({})).toEqual([]);
    expect(readPluginDesignations({ plugins: 'nope' })).toEqual([]);
    expect(readPluginDesignations({ plugins: [{ name: 'x' }] })).toEqual([]);
  });

  it('reads a valid list', () => {
    expect(
      readPluginDesignations({ plugins: [{ marketplace: MP, name: 'forge-codemap' }] }),
    ).toHaveLength(1);
  });
});

describe('mergePluginDesignations', () => {
  it('replaces wholesale and dedupes by marketplace+name', () => {
    const out = mergePluginDesignations([
      { marketplace: MP, name: 'forge-codemap' },
      { marketplace: MP, name: 'forge-codemap', autoUpdate: false },
      { marketplace: MP, name: 'other' },
    ]);
    expect(out?.map((d) => d.name)).toEqual(['forge-codemap', 'other']);
  });

  it('null clears the list', () => {
    expect(mergePluginDesignations(null)).toBeNull();
  });
});

describe('unionPluginDesignations', () => {
  it('unions across projects and records who asked', () => {
    const out = unionPluginDesignations([
      { slug: 'forge-dev', designations: [{ marketplace: MP, name: 'forge-codemap' }] },
      { slug: 'anhome', designations: [{ marketplace: MP, name: 'forge-codemap' }] },
      { slug: 'anhome', designations: [{ marketplace: MP, name: 'forge-shared-skills' }] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      name: 'forge-codemap',
      projects: ['anhome', 'forge-dev'],
      autoUpdate: true,
    });
    expect(out[1]).toMatchObject({ name: 'forge-shared-skills', projects: ['anhome'] });
  });

  it('autoUpdate false from any project wins', () => {
    const out = unionPluginDesignations([
      { slug: 'a', designations: [{ marketplace: MP, name: 'p', autoUpdate: true }] },
      { slug: 'b', designations: [{ marketplace: MP, name: 'p', autoUpdate: false }] },
    ]);
    expect(out[0]?.autoUpdate).toBe(false);
  });

  it('a single pin is adopted', () => {
    const out = unionPluginDesignations([
      { slug: 'a', designations: [{ marketplace: MP, name: 'p', pinnedRef: 'abc1234' }] },
      { slug: 'b', designations: [{ marketplace: MP, name: 'p' }] },
    ]);
    expect(out[0]?.pinnedRef).toBe('abc1234');
    expect(out[0]?.pinnedRefConflict).toBeUndefined();
  });

  it('conflicting pins drop the pin and report both, instead of guessing', () => {
    const out = unionPluginDesignations([
      { slug: 'a', designations: [{ marketplace: MP, name: 'p', pinnedRef: 'abc1234' }] },
      { slug: 'b', designations: [{ marketplace: MP, name: 'p', pinnedRef: 'def5678' }] },
      { slug: 'c', designations: [{ marketplace: MP, name: 'p', pinnedRef: 'abc1234' }] },
    ]);
    expect(out[0]?.pinnedRef).toBeNull();
    expect(out[0]?.pinnedRefConflict).toEqual(['abc1234', 'def5678']);
  });

  it('a later pin cannot resurrect a pin that is already in conflict', () => {
    const out = unionPluginDesignations([
      { slug: 'a', designations: [{ marketplace: MP, name: 'p', pinnedRef: 'abc1234' }] },
      { slug: 'b', designations: [{ marketplace: MP, name: 'p', pinnedRef: 'def5678' }] },
      { slug: 'c', designations: [{ marketplace: MP, name: 'p', pinnedRef: 'abc1234' }] },
      { slug: 'd', designations: [{ marketplace: MP, name: 'p', pinnedRef: 'abc1234' }] },
    ]);
    expect(out[0]?.pinnedRef).toBeNull();
  });

  it('returns [] when no project designates anything', () => {
    expect(unionPluginDesignations([{ slug: 'a', designations: [] }])).toEqual([]);
  });
});
