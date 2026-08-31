import { describe, expect, it } from 'vitest';

import { FORGE_MCP_INSTRUCTIONS } from './instructions.js';

// cm:guard every assertion here pins a POINTER, not wording: the string is auto-loaded into every connected session, so a pointer dropped by a careless edit is not a failed test anywhere — it is an agent that quietly stops recalling memory or stops finding test creds, on every project at once. Rephrase freely; never drop a name.
describe('FORGE_MCP_INSTRUCTIONS', () => {
  it('orients the session and points at the core tools/prompt', () => {
    expect(FORGE_MCP_INSTRUCTIONS).toContain('Forge-managed project');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_memory_search');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('NOT auto-loaded');
    // cm:guard the two `not.toContain`s are the point: ISS-567 removed the local-file knowledge path, and naming `get_knowledge` or `.forge/knowledge.json` again sends every session hunting for a file that does not exist instead of calling `forge_knowledge`
    expect(FORGE_MCP_INSTRUCTIONS).not.toContain('get_knowledge');
    expect(FORGE_MCP_INSTRUCTIONS).not.toContain('.forge/knowledge.json');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_knowledge');
    // cm:guard test creds and preview URLs live on `forge_projects.get` → previewDeploy and NOT on `forge_config`, which returns neither; the instructions must keep saying so, because agents kept looking in `forge_config` and concluding the project had none (feedback cd8ad9f9)
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_projects.get');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('previewDeploy');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_config');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_issues');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge-skills');
    // cm:guard `forge_guide` and `/api/guides` are named as an INDEX — a guide body inlined here would be paid for on every session of every project, which is exactly what ISS-746 moved out to buy the length budget below
    expect(FORGE_MCP_INSTRUCTIONS).toContain('forge_guide');
    expect(FORGE_MCP_INSTRUCTIONS).toContain('/api/guides');
    // cm:guard the projectId stays delegated to the repo CLAUDE.md and is never baked into this string — one baked id makes the instructions project-specific, and they are cached across every project that connects
    expect(FORGE_MCP_INSTRUCTIONS).toContain('CLAUDE.md');
  });

  it('stays tight — it costs context tokens on every connected session', () => {
    // cm:guard this number is a budget, not a style rule: the string is charged to the context of EVERY connected session on every project, so new detail is paid for by moving older detail behind a `forge_guide` pointer — which is how ISS-746 added the capability-guide bullet and still landed below the prior ~1442 chars. Raising the bound instead of moving something out is the move this test exists to catch.
    expect(FORGE_MCP_INSTRUCTIONS.length).toBeLessThan(1450);
  });
});
