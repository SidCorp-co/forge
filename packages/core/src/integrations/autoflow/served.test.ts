// What an Autoflow store serves beyond its workflows, read as the storefront reads it: routes by
// `is_published`, pages by their published state, the theme from the published surface with each
// file's sha-256 and when its snapshot was taken, and settings from the store row.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const site = vi.hoisted(() => ({
  queries: [] as string[],
  answers: {} as Record<
    string,
    { ok: true; data: Record<string, unknown> } | { ok: false; reason: string }
  >,
}));

vi.mock('./live-read.js', () => ({
  autoflowLiveRead: async (_args: unknown, _config: unknown, query: string) => {
    site.queries.push(query);
    const name = /query (\w+)/.exec(query)?.[1] ?? '';
    return site.answers[name] ?? { ok: false, reason: `no answer planted for ${name}` };
  },
}));

const { autoflowStorefrontPublished } = await import('./published.js');

const ask = {
  workflowIds: [] as string[],
  routeIds: ['338', '339', '404'],
  pageIds: ['25', '17', '99'],
  theme: true,
  settingKeys: ['commerce_enabled', 'absent'],
};

const read = (config: Record<string, unknown> = { shop: 'hop', storeId: '11', storeSlug: 'hop' }) =>
  autoflowStorefrontPublished({ connectionId: 'conn-1', config, readSecrets: () => ({}), ask });

beforeEach(() => {
  site.queries = [];
  site.answers = {
    ForgeAutoflowRoutes: {
      ok: true,
      data: {
        backendRoutes: [
          {
            id: '338',
            method: 'GET',
            path: '/hop/rules/dry-run',
            workflow_code: 'hop_rule_trace',
            is_published: true,
          },
          {
            id: 339,
            method: 'POST',
            path: '/hop/rules/dry-run',
            workflow_code: 'hop_rule_trace',
            is_published: false,
          },
        ],
      },
    },
    ForgeAutoflowPages: {
      ok: true,
      data: {
        storePages: [
          {
            id: '25',
            handle: 'rule-test',
            is_published: true,
            published_at: '2026-10-07T19:50:00Z',
            has_unpublished_changes: false,
          },
          {
            id: '17',
            handle: 'reports',
            is_published: false,
            published_at: null,
            has_unpublished_changes: true,
          },
        ],
      },
    },
    ForgeAutoflowTheme: {
      ok: true,
      data: {
        publicResolvedTheme: {
          theme: { id: '815', published_files_version_id: '430' },
          files: [{ path: 'assets/hop-staff-shell.js', checksum: 'ABCDEF0123456789' }],
        },
      },
    },
    ForgeAutoflowThemeSnapshot: {
      ok: true,
      data: { themeVersion: { id: '430', created_at: '2026-10-07T18:40:00Z' } },
    },
    ForgeAutoflowSettings: {
      ok: true,
      data: { store: { id: '11', settings: { commerce_enabled: false } } },
    },
  };
});

describe('autoflowStorefrontPublished beyond workflows', () => {
  it('reads routes, pages, the served theme and settings, each once', async () => {
    const got = await read();
    expect(got.routes.get('338')).toEqual({
      kind: 'published',
      method: 'GET',
      path: '/hop/rules/dry-run',
      workflowCode: 'hop_rule_trace',
    });
    expect(got.routes.get('339')).toMatchObject({ kind: 'unpublished' });
    expect(got.routes.get('404')).toMatchObject({ kind: 'missing' });
    expect(got.pages.get('25')).toEqual({
      kind: 'published',
      handle: 'rule-test',
      publishedAt: '2026-10-07T19:50:00Z',
      unpublishedChanges: false,
    });
    expect(got.pages.get('17')).toEqual({ kind: 'unpublished', handle: 'reports' });
    expect(got.pages.get('99')).toMatchObject({ kind: 'missing' });
    expect(got.theme).toEqual({
      kind: 'served',
      themeId: '815',
      publishedAt: '2026-10-07T18:40:00Z',
      files: new Map([['assets/hop-staff-shell.js', 'abcdef0123456789']]),
    });
    expect(got.settings.get('commerce_enabled')).toEqual({ kind: 'value', value: 'false' });
    expect(got.settings.get('absent')).toMatchObject({ kind: 'missing' });
    expect(site.queries.find((q) => q.includes('storePages'))).toContain('store_id: "11"');
    expect(site.queries.find((q) => q.includes('publicResolvedTheme'))).toContain(
      'store_slug: "hop"',
    );
    expect(site.queries).toHaveLength(5);
  });

  it('answers each kind unreadable with why, never a guess, when its read fails or the binding lacks the store', async () => {
    site.answers.ForgeAutoflowThemeSnapshot = { ok: false, reason: 'graphql_error: forbidden' };
    site.answers.ForgeAutoflowRoutes = { ok: false, reason: 'http_502' };
    const got = await read({ shop: 'hop' });
    expect(got.theme).toMatchObject({
      kind: 'unreadable',
      detail: expect.stringContaining('no snapshot `430` of served theme `815`'),
    });
    expect(got.routes.get('338')).toMatchObject({
      kind: 'unreadable',
      detail: expect.stringContaining('http_502'),
    });
    expect(got.pages.get('25')).toMatchObject({
      kind: 'unreadable',
      detail: expect.stringContaining('records no `storeId`'),
    });
    expect(got.settings.get('commerce_enabled')).toMatchObject({ kind: 'unreadable' });
  });
});
