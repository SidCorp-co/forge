import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the DB at the module boundary. Each call to `.limit(1)` returns the
// next queued row array — order is: 1) global skill lookup, 2) project
// override lookup.
const limitMock = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (_n: number) => limitMock(),
        }),
      }),
    }),
  },
}));

const { resolveSkill, assertSkillLoadable, SkillNotLoadableError } = await import(
  './skill-loader.js'
);

beforeEach(() => {
  limitMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const SKILL_ID = '33333333-3333-4333-8333-333333333333';

describe('resolveSkill', () => {
  it('returns loadable=true from global when no override and body non-empty', async () => {
    limitMock
      .mockResolvedValueOnce([
        { id: SKILL_ID, skillMd: '# forge-review\n\nbody', prompt: '', contentHash: 'h-global' },
      ])
      .mockResolvedValueOnce([]);

    const r = await resolveSkill('forge-review', PROJECT_ID);
    expect(r).toEqual({ loadable: true, source: 'global', contentHash: 'h-global' });
  });

  it('returns loadable=true from project override when present and non-empty', async () => {
    limitMock
      .mockResolvedValueOnce([
        { id: SKILL_ID, skillMd: '# global', prompt: '', contentHash: 'h-global' },
      ])
      .mockResolvedValueOnce([{ skillMdOverride: '# override body', contentHash: 'h-override' }]);

    const r = await resolveSkill('forge-review', PROJECT_ID);
    expect(r).toEqual({
      loadable: true,
      source: 'project_override',
      contentHash: 'h-override',
    });
  });

  it('returns skill_not_found when no global row exists', async () => {
    limitMock.mockResolvedValueOnce([]);

    const r = await resolveSkill('forge-missing', PROJECT_ID);
    expect(r).toMatchObject({
      loadable: false,
      reason: 'skill_not_found',
      skillName: 'forge-missing',
    });
  });

  it('returns skill_empty_body when global has neither skillMd nor prompt', async () => {
    limitMock
      .mockResolvedValueOnce([
        { id: SKILL_ID, skillMd: null, prompt: '', contentHash: 'h' },
      ])
      .mockResolvedValueOnce([]);

    const r = await resolveSkill('forge-empty', PROJECT_ID);
    expect(r).toMatchObject({ loadable: false, reason: 'skill_empty_body' });
  });

  it('treats a blanked override as intentional disable (skill_empty_body)', async () => {
    limitMock
      .mockResolvedValueOnce([
        { id: SKILL_ID, skillMd: '# global ok', prompt: '', contentHash: 'h' },
      ])
      .mockResolvedValueOnce([{ skillMdOverride: '   \n  ', contentHash: 'h-ov' }]);

    const r = await resolveSkill('forge-review', PROJECT_ID);
    expect(r).toMatchObject({ loadable: false, reason: 'skill_empty_body' });
  });

  it('falls back to global.prompt when global.skillMd is NULL (legacy seed)', async () => {
    limitMock
      .mockResolvedValueOnce([
        { id: SKILL_ID, skillMd: null, prompt: 'legacy prompt body', contentHash: 'h-legacy' },
      ])
      .mockResolvedValueOnce([]);

    const r = await resolveSkill('forge-legacy', PROJECT_ID);
    expect(r).toEqual({ loadable: true, source: 'global', contentHash: 'h-legacy' });
  });
});

describe('assertSkillLoadable', () => {
  it('resolves quietly when the skill is loadable', async () => {
    limitMock
      .mockResolvedValueOnce([
        { id: SKILL_ID, skillMd: 'ok', prompt: '', contentHash: 'h' },
      ])
      .mockResolvedValueOnce([]);
    await expect(assertSkillLoadable('forge-review', PROJECT_ID)).resolves.toBeUndefined();
  });

  it('throws SkillNotLoadableError when missing', async () => {
    limitMock.mockResolvedValueOnce([]);
    await expect(assertSkillLoadable('forge-missing', PROJECT_ID)).rejects.toBeInstanceOf(
      SkillNotLoadableError,
    );
  });
});
