import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ISS-623 W2 — the mcp-servers preamble block. Mirrors the mocking pattern in
// `lib/chat-preamble.test.ts` (mock `db/client.js` so `loadProjectBranches`
// short-circuits) since there is no other `system.ts` unit test file to add
// to. `config/env.js` and `knowledge/service.js` are mocked too — `system.ts`
// transitively imports `facts/resolve.js`, which imports both at module
// scope; `config/env.js` validates real process.env eagerly on import (would
// throw under test) and `knowledge/service.js` pulls in the embeddings
// client, same pattern as `facts/resolve.parity.test.ts`.
vi.mock('../db/client.js', () => {
  const select = vi.fn();
  return { db: { select } };
});
vi.mock('../config/env.js', () => ({ env: { KNOWLEDGE_INJECTION_ENABLED: false } }));
vi.mock('../knowledge/service.js', () => ({
  selectAlwaysInjectFromKnowledge: vi.fn(),
  selectOnDemandSlugsFromKnowledge: vi.fn(),
}));

const { db } = await import('../db/client.js');
const { buildPipelinePreambleStructured } = await import('./system.js');

function mockBranchSelectError(): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  (db as any).select.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          throw new Error('no row');
        },
      }),
    }),
  }));
}

describe('buildPipelinePreambleStructured — mcp-servers block (ISS-623 W2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBranchSelectError();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('omits the mcp-servers block when mcpDiagnostics is absent', async () => {
    const built = await buildPipelinePreambleStructured('p1');
    expect(built.blocks.map((b) => b.id)).not.toContain('mcp-servers');
  });

  it('omits the mcp-servers block when dropped is empty (clean dispatch)', async () => {
    const built = await buildPipelinePreambleStructured('p1', {
      mcpDiagnostics: { resolved: ['playwright'], dropped: [] },
    });
    expect(built.blocks.map((b) => b.id)).not.toContain('mcp-servers');
  });

  it('adds the mcp-servers block listing resolved + dropped names when dropped is non-empty', async () => {
    const built = await buildPipelinePreambleStructured('p1', {
      mcpDiagnostics: { resolved: ['playwright'], dropped: ['shop'] },
    });
    expect(built.blocks.map((b) => b.id)).toContain('mcp-servers');
    expect(built.content).toContain('mcp__playwright__*');
    expect(built.content).toContain('`shop`');
    expect(built.content).toContain('STOP');
  });

  it('mcp-servers block appears after any state block and before state-extras', async () => {
    const built = await buildPipelinePreambleStructured('p1', {
      step: 'code',
      override: { mode: 'append', extras: 'extra rules' },
      mcpDiagnostics: { resolved: [], dropped: ['epodsystem'] },
    });
    const ids = built.blocks.map((b) => b.id);
    const mcpIdx = ids.indexOf('mcp-servers');
    const extrasIdx = ids.indexOf('state-extras');
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(extrasIdx).toBeGreaterThan(mcpIdx);
  });
});
