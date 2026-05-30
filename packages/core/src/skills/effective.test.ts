import { describe, expect, it, vi } from 'vitest';

// effective.ts imports db/client (env-validated at import) for its async
// resolvers; these pure-function tests don't touch the DB, so stub both.
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { computeDeviceSkillStatus, computeEffectiveSkill } = await import('./effective.js');
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

  it('applies a global override body but keeps the base files', () => {
    const row = baseRow();
    const eff = computeEffectiveSkill(row, { skillMdOverride: '# Local' });
    expect(eff.skillMd).toBe('# Local');
    expect(eff.isOverridden).toBe(true);
    // Override carries no files — hash must fold in the base files, NOT the
    // files-blind override.contentHash.
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
