/**
 * What the nine-tool chat catalog costs to send, by the method ISS-986 states:
 * build every factory `CHAT_TOOL_ALLOWLIST` names and serialise each as the
 * OpenAI tool it becomes. The figures compose with that issue's table because
 * they are produced the same way — the point of pinning the method here rather
 * than re-deriving it per issue.
 */

import { describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../../mcp/fake-principal.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const { CHAT_TOOL_ALLOWLIST } = await import('./registry.js');

// cm:guard serialise the FACTORY's description, never `buildToolset`'s — that one truncates at DESCRIPTION_CAP, so measuring it reports the cap back instead of what the catalog costs, and every figure ISS-984 and ISS-986 quote would silently become 1,024.
function serialisedSize(): { byName: Map<string, number>; total: number } {
  const ctx = {
    principal: makeFakePrincipal('token', 'user'),
    projectSlug: 'forge-dev',
    boundProjectId: null,
  };
  const byName = new Map<string, number>();
  let total = 0;
  for (const spec of CHAT_TOOL_ALLOWLIST) {
    const tool = spec.factory(ctx);
    const size = JSON.stringify({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }).length;
    byName.set(tool.name, size);
    total += size;
  }
  return { byName, total };
}

describe('the chat tool catalog, serialised', () => {
  it('sends nine tools, the allowlist and the measurement agreeing on which', () => {
    expect(serialisedSize().byName.size).toBe(CHAT_TOOL_ALLOWLIST.length);
  });

  // cm:guard 13,105 at b4850a2e, and forge_issues was 46% of the catalog on its own (ISS-984). Raising this ceiling to admit a longer description is how that percentage comes back.
  it('keeps forge_issues under 11,000 characters', () => {
    expect(serialisedSize().byName.get('forge_issues')).toBeLessThan(11_000);
  });

  // cm:guard 28,343 at b4850a2e. This is a per-request cost paid on every assistant turn, so it is a budget and not a record of where the number happens to sit.
  it('keeps the whole catalog under 26,500 characters', () => {
    expect(serialisedSize().total).toBeLessThan(26_500);
  });
});
