/**
 * ISS-1009 — the chat door files through the CLI, and offers no second way.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const { CHAT_TOOL_ALLOWLIST } = await import('./registry.js');
const { forgeCliTool } = await import('./forge-cli-tool.js');
const { forgeIssuesTool } = await import('../../mcp/tools/forge-issues.js');
const { forgeCommentsTool } = await import('../../mcp/tools/forge-comments.js');

describe('one door for a filing', () => {
  // cm:guard neither wrapper may come back beside the CLI: measured 2026-09-15 with both offered, the model reached the wrapper for a status question, a duplicate check and a settings change while the persona named the CLI (ISS-1009).
  it('offers neither forge_issues nor forge_comments', () => {
    const factories = CHAT_TOOL_ALLOWLIST.map((s) => s.factory);
    expect(factories).not.toContain(forgeIssuesTool);
    expect(factories).not.toContain(forgeCommentsTool);
  });

  it('offers the forge CLI, and first', () => {
    expect(CHAT_TOOL_ALLOWLIST[0]?.factory).toBe(forgeCliTool);
  });
});
