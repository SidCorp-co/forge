import { describe, expect, it } from 'vitest';

import { FORGE_MCP_INSTRUCTIONS } from './instructions.js';

// The MCP `instructions` string is auto-loaded into every connected session, so
// it's load-bearing orientation — pin the key pointers so a careless edit can't
// silently drop them. (Mirrors how system.test.ts pins the CHAT_NUDGE.)
describe('FORGE_MCP_INSTRUCTIONS', () => {
  it('orients the session and points at the core tools/prompt', () => {
    expect(FORGE_MCP_INSTRUCTIONS).toContain('Forge-managed project');
    // recall-first memory contract
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_memory_search');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('NOT auto-loaded');
    // codebase orientation
    expect(FORGE_MCP_INSTRUCTIONS).toContain('get_knowledge');
    // project-management tools
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_issues');
    // skill-authoring meta prompt
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge-skills');
    // projectId is delegated to the repo CLAUDE.md, not baked here (stays
    // cache-shareable across projects)
    expect(FORGE_MCP_INSTRUCTIONS).toContain('CLAUDE.md');
  });

  it('stays tight — it costs context tokens on every connected session', () => {
    // Guardrail, not a hard spec: if this grows a lot, reconsider whether the
    // content belongs in a forge-* MCP prompt instead of always-on instructions.
    expect(FORGE_MCP_INSTRUCTIONS.length).toBeLessThan(1200);
  });
});
