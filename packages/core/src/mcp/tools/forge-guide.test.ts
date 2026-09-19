import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: { select: vi.fn() } }));

const { FORGE_GUIDES, listGuides } = await import('../../guides/registry.js');
const { forgeGuideTool } = await import('./forge-guide.js');
const { INTEGRATION_GUIDE_SLUG_PREFIX } = await import('../../guides/integration-guides.js');

const tool = forgeGuideTool({
  principal: { kind: 'pat', agency: null, agentUserId: null, userId: 'u1', tokenId: 't1' },
  device: { id: 'd1', ownerId: 'u1' },
  projectSlug: null,
} as unknown as Parameters<typeof forgeGuideTool>[0]);

describe('forge_guide MCP tool', () => {
  it('name and description name the tool + the public URL form', () => {
    expect(tool.name).toBe('forge_guide');
    expect(tool.description).toContain('/api/guides');
  });

  it('action=list omits bodies and matches the registry index', async () => {
    const result = (await tool.handler({ action: 'list' })) as { guides: Array<{ slug: string }> };
    expect(result.guides).toEqual(listGuides());
    for (const g of result.guides) {
      expect('body' in g).toBe(false);
    }
  });

  it('action=get returns the full guide body', async () => {
    const target = FORGE_GUIDES[0];
    expect(target).toBeDefined();
    if (!target) return;
    const result = (await tool.handler({ action: 'get', slug: target.slug })) as {
      guide: { slug: string; body: string };
    };
    expect(result.guide).toEqual(target);
  });

  it('action=get with no slug -> BAD_REQUEST', async () => {
    await expect(tool.handler({ action: 'get' })).rejects.toThrow('BAD_REQUEST');
  });

  it('action=get with an unknown slug -> NOT_FOUND naming valid slugs', async () => {
    await expect(tool.handler({ action: 'get', slug: 'nope' })).rejects.toThrow(
      /NOT_FOUND.*project-settings-and-test-credentials/,
    );
  });

  it('rejects an action outside the enum', async () => {
    await expect(tool.handler({ action: 'publish' })).rejects.toBeTruthy();
  });

  it('serves the code tier with no project context at all', async () => {
    const result = (await tool.handler({ action: 'list' })) as { guides: unknown[] };
    expect(result.guides.length).toBe(FORGE_GUIDES.length);
  });

  it('a write with no project context -> BAD_REQUEST (a guide is per-org)', async () => {
    await expect(
      tool.handler({
        action: 'upsert',
        provider: 'epodsystem',
        title: 't',
        summary: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/BAD_REQUEST.*per-org/);
  });

  it('a write for an unknown provider is refused before any org lookup', async () => {
    await expect(
      tool.handler({ action: 'upsert', provider: 'shopify', title: 't', summary: 's', body: 'b' }),
    ).rejects.toThrow(/unknown integration provider/);
  });

  it('a write with neither provider nor slug -> BAD_REQUEST', async () => {
    await expect(tool.handler({ action: 'delete' })).rejects.toThrow(/provider is required/);
  });

  it('no code guide claims the integration slug prefix', () => {
    for (const g of FORGE_GUIDES) {
      expect(g.slug.startsWith(INTEGRATION_GUIDE_SLUG_PREFIX)).toBe(false);
    }
  });
});
