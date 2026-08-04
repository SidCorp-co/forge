import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('./endpoints.js', () => ({
  epodsystemGraphqlBase: () => 'https://admin.example.test/graphql',
}));

const { fetchStorefrontThemes } = await import('./themes.js');

const MAIN = { id: 100, name: 'Store Theme', role: 'main', parent_theme_id: null };
const DRAFT = { id: 200, name: 'Store Theme draft', role: 'unpublished', parent_theme_id: 100 };
// cm:why a demoted previous main is ALSO role=unpublished — publishDraftTheme demotes it "as a one-click backup", which is exactly why role alone cannot identify the draft
const OLD_MAIN_BACKUP = {
  id: 50,
  name: 'Store Theme (backup)',
  role: 'unpublished',
  parent_theme_id: null,
};

function mockFetch(...responses: unknown[]): void {
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = queue.shift() ?? { data: {} };
      return { ok: true, json: async () => body } as unknown as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchStorefrontThemes', () => {
  it('resolves the main theme and its draft clone', async () => {
    mockFetch(
      { data: { storeThemes: [MAIN, DRAFT] } },
      {
        data: {
          themeVersions: [{ id: 9, version_number: 3, label: 'pre-publish', created_at: 'T' }],
        },
      },
    );
    const out = await fetchStorefrontThemes('crmk_x', '59');
    expect(out?.mainThemeId).toBe('100');
    expect(out?.draftThemeId).toBe('200');
    expect(out?.themes).toHaveLength(2);
    expect(out?.versions).toEqual([
      { id: '9', versionNumber: 3, label: 'pre-publish', createdAt: 'T' },
    ]);
  });

  // cm:guard this is the whole point of keying on parent_theme_id — handing back a demoted backup would make a step build on, or publish, the wrong theme
  it('never mistakes a demoted previous main for the draft', async () => {
    mockFetch({ data: { storeThemes: [MAIN, OLD_MAIN_BACKUP] } }, { data: { themeVersions: [] } });
    const out = await fetchStorefrontThemes('crmk_x', '59');
    expect(out?.draftThemeId).toBeNull();
  });

  it('picks the draft whose parent is the CURRENT main, not another unpublished theme', async () => {
    mockFetch(
      { data: { storeThemes: [MAIN, OLD_MAIN_BACKUP, DRAFT] } },
      { data: { themeVersions: [] } },
    );
    const out = await fetchStorefrontThemes('crmk_x', '59');
    expect(out?.draftThemeId).toBe('200');
  });

  it('returns a null draft when no draft exists yet', async () => {
    mockFetch({ data: { storeThemes: [MAIN] } }, { data: { themeVersions: [] } });
    const out = await fetchStorefrontThemes('crmk_x', '59');
    expect(out?.draftThemeId).toBeNull();
    expect(out?.mainThemeId).toBe('100');
  });

  it('coerces numeric ids to strings so callers can compare them safely', async () => {
    mockFetch({ data: { storeThemes: [MAIN, DRAFT] } }, { data: { themeVersions: [] } });
    const out = await fetchStorefrontThemes('crmk_x', '59');
    expect(out?.themes.map((t) => t.id)).toEqual(['100', '200']);
    expect(out?.themes[1]?.parentThemeId).toBe('100');
  });

  // cm:guard null (query failed) must stay distinguishable from an empty result — the tool turns it into themesResolvedLive:false, and collapsing the two is how "unknown" gets read as "no draft"
  it('returns null when the query errors', async () => {
    mockFetch({ errors: [{ message: 'unauthenticated' }] });
    expect(await fetchStorefrontThemes('bad', '59')).toBeNull();
  });

  it('returns null on a non-ok HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response),
    );
    expect(await fetchStorefrontThemes('crmk_x', '59')).toBeNull();
  });

  it('returns null when fetch throws (timeout / network)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout');
      }),
    );
    expect(await fetchStorefrontThemes('crmk_x', '59')).toBeNull();
  });

  it('skips the versions query when there is no main theme', async () => {
    const f = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ data: { storeThemes: [DRAFT] } }),
        }) as unknown as Response,
    );
    vi.stubGlobal('fetch', f);
    const out = await fetchStorefrontThemes('crmk_x', '59');
    expect(out?.mainThemeId).toBeNull();
    expect(out?.versions).toEqual([]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  // cm:guard the key belongs in the Authorization header and nowhere else — a key echoed into the request body lands in provider-side request logs
  it('never puts the api key in the query body', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init);
        return {
          ok: true,
          json: async () => ({ data: { storeThemes: [] } }),
        } as unknown as Response;
      }),
    );
    await fetchStorefrontThemes('crmk_supersecret', '59');
    expect(seen).toHaveLength(1);
    expect(String(seen[0]?.body)).not.toContain('crmk_supersecret');
    expect(JSON.stringify(seen[0]?.headers)).toContain('crmk_supersecret');
  });
});
