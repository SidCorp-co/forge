import { describe, expect, it, vi } from 'vitest';

// effective.ts imports db/client (env-validated at import) for its async
// resolvers; these pure-function tests don't touch the DB, so stub both.
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const {
  computeDeviceSkillStatus,
  computeEffectiveSkill,
  globalEffectiveHash,
  globalEffectiveMd,
  pivotProjectSkillSyncStatus,
} = await import('./effective.js');
type EffectiveSkill = import('./effective.js').EffectiveSkill;
type SkillBodyRow = import('./effective.js').SkillBodyRow;
const { hashSkillBody } = await import('./hash.js');

const baseRow = (over: Partial<SkillBodyRow> = {}): SkillBodyRow => ({
  id: 's-1',
  name: 'forge-code',
  version: 1,
  scope: 'global',
  skillMd: '# Skill',
  prompt: 'legacy prompt',
  files: [{ path: 'references/a.md', content: 'A', encoding: 'utf8' }],
  ...over,
});

describe('computeEffectiveSkill', () => {
  it('uses skillMd + files and recomputes hashSkillBody for a plain global', () => {
    const row = baseRow();
    const eff = computeEffectiveSkill(row, undefined);
    expect(eff.skillMd).toBe('# Skill');
    expect(eff.isOverridden).toBe(false);
    expect(eff.effectiveHash).toBe(hashSkillBody('# Skill', row.files));
  });

  it('falls back to base files when the override forks no files (legacy row)', () => {
    const row = baseRow();
    const eff = computeEffectiveSkill(row, { skillMdOverride: '# Local', files: [] });
    expect(eff.skillMd).toBe('# Local');
    expect(eff.isOverridden).toBe(true);
    expect(eff.files).toEqual(row.files);
    // Empty override files → hash folds in the base files, NOT the
    // files-blind override.contentHash.
    expect(eff.effectiveHash).toBe(hashSkillBody('# Local', row.files));
  });

  it('uses the override files when the fork carries its own folder', () => {
    const row = baseRow();
    const overrideFiles = [{ path: 'references/b.md', content: 'B', encoding: 'utf8' as const }];
    const eff = computeEffectiveSkill(row, { skillMdOverride: '# Local', files: overrideFiles });
    expect(eff.skillMd).toBe('# Local');
    expect(eff.isOverridden).toBe(true);
    expect(eff.files).toEqual(overrideFiles);
    expect(eff.effectiveHash).toBe(hashSkillBody('# Local', overrideFiles));
  });

  it('treats a missing override files field as no fork (falls back to base files)', () => {
    const row = baseRow();
    const eff = computeEffectiveSkill(row, { skillMdOverride: '# Local' });
    expect(eff.files).toEqual(row.files);
    expect(eff.effectiveHash).toBe(hashSkillBody('# Local', row.files));
  });

  it('falls back to prompt when skillMd is null (legacy skill)', () => {
    const row = baseRow({ skillMd: null });
    const eff = computeEffectiveSkill(row, undefined);
    expect(eff.skillMd).toBe('legacy prompt');
    expect(eff.effectiveHash).toBe(hashSkillBody('legacy prompt', row.files));
  });

  it('ignores overrides for project-scoped skills', () => {
    const row = baseRow({ scope: 'project', skillMd: '# Project' });
    const eff = computeEffectiveSkill(row, { skillMdOverride: '# ShouldBeIgnored' });
    expect(eff.skillMd).toBe('# Project');
    expect(eff.isOverridden).toBe(false);
  });
});

describe('globalEffective helpers', () => {
  it('globalEffectiveMd prefers skillMd, falls back to prompt', () => {
    expect(globalEffectiveMd({ skillMd: '# Md', prompt: 'p' })).toBe('# Md');
    expect(globalEffectiveMd({ skillMd: null, prompt: 'p' })).toBe('p');
    expect(globalEffectiveMd({ skillMd: '   ', prompt: 'p' })).toBe('p');
    expect(globalEffectiveMd({ skillMd: null, prompt: null })).toBe('');
  });

  it('globalEffectiveHash matches hashSkillBody over the effective body', () => {
    const files = [{ path: 'a.md', content: 'A', encoding: 'utf8' as const }];
    expect(globalEffectiveHash({ skillMd: '# Md', prompt: 'p', files })).toBe(
      hashSkillBody('# Md', files),
    );
    // legacy prompt-only skill hashes off the prompt fallback
    expect(globalEffectiveHash({ skillMd: null, prompt: 'p', files })).toBe(
      hashSkillBody('p', files),
    );
  });
});

describe('computeDeviceSkillStatus', () => {
  const eff: EffectiveSkill[] = [
    {
      skillId: 's-1',
      name: 'a',
      version: 1,
      skillMd: '',
      files: [],
      effectiveHash: 'h1',
      isOverridden: false,
    },
    {
      skillId: 's-2',
      name: 'b',
      version: 1,
      skillMd: '',
      files: [],
      effectiveHash: 'h2',
      isOverridden: false,
    },
    {
      skillId: 's-3',
      name: 'c',
      version: 1,
      skillMd: '',
      files: [],
      effectiveHash: 'h3',
      isOverridden: false,
    },
  ];

  it('classifies synced / outdated / missing', () => {
    const syncedAt = new Date('2026-05-30T00:00:00.000Z');
    const status = computeDeviceSkillStatus(eff, [
      { skillId: 's-1', installedHash: 'h1', installedVersion: 1, syncedAt },
      { skillId: 's-2', installedHash: 'STALE', installedVersion: 1, syncedAt },
      // s-3 absent → missing
    ]);
    const byId = Object.fromEntries(status.map((s) => [s.skillId, s]));
    expect(byId['s-1']?.status).toBe('synced');
    expect(byId['s-2']?.status).toBe('outdated');
    expect(byId['s-3']?.status).toBe('missing');
    expect(byId['s-1']?.syncedAt).toBe(syncedAt.toISOString());
    expect(byId['s-3']?.installedHash).toBeNull();
  });
});

describe('pivotProjectSkillSyncStatus', () => {
  const eff: EffectiveSkill[] = [
    { skillId: 's-1', name: 'a', version: 5, skillMd: '', files: [], effectiveHash: 'h1', isOverridden: false },
    { skillId: 's-2', name: 'b', version: 2, skillMd: '', files: [], effectiveHash: 'h2', isOverridden: false },
  ];
  const devicesList = [
    { deviceId: 'd-1', name: 'laptop', status: 'online', lastSeenAt: null },
    { deviceId: 'd-2', name: 'desktop', status: 'offline', lastSeenAt: null },
  ];

  it('pivots into a skill-major shape with per-device synced/outdated/missing', () => {
    const installedByDevice = new Map([
      // d-1: s-1 synced, s-2 outdated
      [
        'd-1',
        [
          { skillId: 's-1', installedHash: 'h1', installedVersion: 5, syncedAt: null },
          { skillId: 's-2', installedHash: 'OLD', installedVersion: 1, syncedAt: null },
        ],
      ],
      // d-2: no install rows → everything missing
    ]);

    const out = pivotProjectSkillSyncStatus(devicesList, eff, installedByDevice);

    expect(out.devices).toHaveLength(2);
    expect(out.skills.map((s) => s.skillId)).toEqual(['s-1', 's-2']);

    const s1 = out.skills.find((s) => s.skillId === 's-1')!;
    expect(s1.currentVersion).toBe(5);
    expect(s1.devices.find((d) => d.deviceId === 'd-1')?.status).toBe('synced');
    expect(s1.devices.find((d) => d.deviceId === 'd-2')?.status).toBe('missing');

    const s2 = out.skills.find((s) => s.skillId === 's-2')!;
    const s2d1 = s2.devices.find((d) => d.deviceId === 'd-1')!;
    expect(s2d1.status).toBe('outdated');
    expect(s2d1.installedVersion).toBe(1);
  });

  it('returns each skill with an empty devices array when no devices are bound', () => {
    const out = pivotProjectSkillSyncStatus([], eff, new Map());
    expect(out.devices).toEqual([]);
    expect(out.skills).toHaveLength(2);
    expect(out.skills.every((s) => s.devices.length === 0)).toBe(true);
  });
});
