// REQ-47 BC-7: the transport fences a call by the projectId it sends only where the tool takes one;
// a tool that takes none meets it as a wrong argument its own strict input refuses by name.

import { describe, expect, it } from 'vitest';
import type { McpContext } from '../lib/tool.js';
import { mcpTools, takesProjectArgument } from './server.js';

const ctx = {
  principal: { kind: 'pat', userId: 'u', tokenId: 't', permissions: null, scopes: ['read'] },
  projectSlug: null,
} as unknown as McpContext;

describe('takesProjectArgument', () => {
  const byName = new Map(mcpTools(ctx).map((t) => [t.name, takesProjectArgument(t)]));

  it('fences the tools that take the project they work in', () => {
    expect(byName.get('project_feedback')).toBe(true);
    expect(byName.get('forge_requirements')).toBe(true);
  });

  it('does not fence forge_feedback, which files into Forge’s home and takes no project', () => {
    expect(byName.get('forge_feedback')).toBe(false);
  });

  it('reads a projectId under filters as one the tool takes', () => {
    const tool = {
      name: 'filtered',
      inputSchema: { properties: { filters: { properties: { projectId: {} } } } },
    };
    expect(takesProjectArgument(tool)).toBe(true);
  });

  it('refuses a tool that takes no project and would drop a projectId in silence', () => {
    const loose = { name: 'loose_tool', inputSchema: { properties: { action: {} } } };
    expect(() => takesProjectArgument(loose)).toThrow(/loose_tool takes no projectId/);
  });
});
