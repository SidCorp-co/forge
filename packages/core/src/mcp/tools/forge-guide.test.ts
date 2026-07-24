import { describe, expect, it } from 'vitest';
import { FORGE_GUIDES, listGuides } from '../../guides/registry.js';
import { forgeGuideTool } from './forge-guide.js';

describe('forge_guide MCP tool', () => {
  it('name and description name the tool + the public URL form', () => {
    expect(forgeGuideTool.name).toBe('forge_guide');
    expect(forgeGuideTool.description).toContain('/api/guides');
  });

  it('action=list omits bodies and matches the registry index', async () => {
    const result = (await forgeGuideTool.handler({ action: 'list' })) as {
      guides: Array<{ slug: string }>;
    };
    expect(result.guides).toEqual(listGuides());
    for (const g of result.guides) {
      expect('body' in g).toBe(false);
    }
  });

  it('action=get returns the full guide body', async () => {
    const target = FORGE_GUIDES[0];
    expect(target).toBeDefined();
    if (!target) return;
    const result = (await forgeGuideTool.handler({ action: 'get', slug: target.slug })) as {
      guide: { slug: string; body: string };
    };
    expect(result.guide).toEqual(target);
  });

  it('action=get with no slug -> BAD_REQUEST', async () => {
    await expect(forgeGuideTool.handler({ action: 'get' })).rejects.toThrow('BAD_REQUEST');
  });

  it('action=get with an unknown slug -> NOT_FOUND naming valid slugs', async () => {
    await expect(forgeGuideTool.handler({ action: 'get', slug: 'nope' })).rejects.toThrow(
      /NOT_FOUND.*project-settings-and-test-credentials/,
    );
  });

  it('rejects an action outside the list|get enum', async () => {
    await expect(forgeGuideTool.handler({ action: 'delete' })).rejects.toBeTruthy();
  });

  it('has no projectId in its input schema — product-global, no membership required', () => {
    const props = (forgeGuideTool.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(props).toBeDefined();
    expect(props && 'projectId' in props).toBe(false);
  });
});
