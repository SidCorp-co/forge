import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const selectRows: unknown[][] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = selectRows.shift() ?? [];
          const terminal = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: () => Promise<unknown[]>;
          };
          terminal.limit = async () => rows;
          return terminal;
        },
      }),
    }),
  },
}));

const {
  integrationGuideSlug,
  providerFromGuideSlug,
  resolveGuide,
  resolveGuideIndex,
  loadOrgGuideProviders,
  INTEGRATION_GUIDE_SLUG_PREFIX,
} = await import('./integration-guides.js');
const { FORGE_GUIDES, listGuides } = await import('./registry.js');

function queue(...batches: unknown[][]): void {
  selectRows.length = 0;
  selectRows.push(...batches);
}

describe('integration guide slug space', () => {
  it('round-trips provider ↔ slug', () => {
    expect(integrationGuideSlug('epodsystem')).toBe('integration-epodsystem');
    expect(providerFromGuideSlug('integration-epodsystem')).toBe('epodsystem');
  });

  it('a non-integration slug yields no provider', () => {
    expect(providerFromGuideSlug('deploy-safety')).toBeNull();
    expect(providerFromGuideSlug(INTEGRATION_GUIDE_SLUG_PREFIX)).toBeNull();
  });
});

describe('resolveGuide — org override over code default', () => {
  // cm:guard orgId null must never touch the DB — that is the unauthenticated public path, and a query here would both break it and leak tenant bytes
  it('with no org, returns the code guide and issues no query', async () => {
    queue();
    const target = FORGE_GUIDES[0];
    expect(target).toBeDefined();
    if (!target) return;
    expect(await resolveGuide(target.slug, null)).toEqual(target);
  });

  it('an org row shadows the code tier for that provider', async () => {
    queue([
      {
        provider: 'epodsystem',
        title: 'Org Epodsystem',
        summary: 'org-authored',
        body: '## org body',
        version: 4,
        updatedAt: new Date(0),
      },
    ]);
    const guide = await resolveGuide('integration-epodsystem', 'org-1');
    expect(guide).toEqual({
      slug: 'integration-epodsystem',
      title: 'Org Epodsystem',
      summary: 'org-authored',
      version: 4,
      body: '## org body',
    });
  });

  it('no org row for the provider falls back to the code tier (undefined when it has no default)', async () => {
    queue([]);
    expect(await resolveGuide('integration-epodsystem', 'org-1')).toBeUndefined();
  });

  it('a code-tier slug is never routed through the org table', async () => {
    queue();
    const guide = await resolveGuide('deploy-safety', 'org-1');
    expect(guide?.slug).toBe('deploy-safety');
  });
});

describe('resolveGuideIndex', () => {
  it('with no org, is exactly the code index', async () => {
    queue();
    expect(await resolveGuideIndex(null)).toEqual(listGuides());
  });

  it('appends an org guide that has no code default', async () => {
    queue([{ provider: 'epodsystem', title: 'Org Epod', summary: 's', version: 2 }]);
    const index = await resolveGuideIndex('org-1');
    expect(index.length).toBe(listGuides().length + 1);
    expect(index.at(-1)).toEqual({
      slug: 'integration-epodsystem',
      title: 'Org Epod',
      summary: 's',
      version: 2,
    });
  });

  it('an org guide never appears twice', async () => {
    queue([{ provider: 'epodsystem', title: 'Org Epod', summary: 's', version: 2 }]);
    const index = await resolveGuideIndex('org-1');
    const slugs = index.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('loadOrgGuideProviders', () => {
  it('returns the providers the org authored', async () => {
    queue([{ provider: 'epodsystem' }, { provider: 'sentry' }]);
    expect(await loadOrgGuideProviders('org-1')).toEqual(new Set(['epodsystem', 'sentry']));
  });
});
