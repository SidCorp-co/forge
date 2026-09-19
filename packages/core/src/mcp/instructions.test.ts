import { describe, expect, it } from 'vitest';

import { FORGE_MCP_INSTRUCTIONS } from './instructions.js';

describe('FORGE_MCP_INSTRUCTIONS', () => {
  it('orients the session and points at the core tools/prompt', () => {
    expect(FORGE_MCP_INSTRUCTIONS).toContain('Forge-managed project');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_memory_search');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('NOT auto-loaded');
    expect(FORGE_MCP_INSTRUCTIONS).not.toContain('get_knowledge');
    expect(FORGE_MCP_INSTRUCTIONS).not.toContain('.forge/knowledge.json');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_knowledge');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_projects.get');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('environments');
    expect(FORGE_MCP_INSTRUCTIONS).not.toContain('previewDeploy');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_config');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_issues');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge-skills');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_guide');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('/api/guides');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('CLAUDE.md');
  });

  it('stays tight — it costs context tokens on every connected session', () => {
    expect(FORGE_MCP_INSTRUCTIONS.length).toBeLessThan(1450);
  });
});
