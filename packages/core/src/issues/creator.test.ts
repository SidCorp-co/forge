import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const selectWhere = vi.fn((): { id: string; email: string }[] => []);
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

const {
  isAgentChannel,
  hydrateCreatorsForIssues,
  buildCreatedByCondition,
  buildOriginCondition,
  FORGE_AGENT_LABEL,
} = await import('./creator.js');

describe('isAgentChannel', () => {
  it('NULL (legacy row) is human', () => {
    expect(isAgentChannel(null)).toBe(false);
  });
  it("'web' is human", () => {
    expect(isAgentChannel('web')).toBe(false);
  });
  it.each(['mcp', 'pipeline', 'schedule', 'system'])('%s is agent', (v) => {
    expect(isAgentChannel(v)).toBe(true);
  });
});

describe('hydrateCreatorsForIssues', () => {
  it('empty input skips the query', async () => {
    const map = await hydrateCreatorsForIssues([]);
    expect(map.size).toBe(0);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('web-created row resolves to the creator email, never a raw id', async () => {
    selectWhere.mockReturnValueOnce([{ id: 'u1', email: 'owner@example.com' }]);
    const map = await hydrateCreatorsForIssues([
      { id: 'i1', createdById: 'u1', createdVia: 'web' },
    ]);
    expect(map.get('i1')).toEqual({
      creatorEmail: 'owner@example.com',
      creatorIsAgent: false,
      creatorLabel: 'owner@example.com',
    });
  });

  it('mcp-created row labels Forge Agent and does not leak the owner email as the label', async () => {
    selectWhere.mockReturnValueOnce([{ id: 'u1', email: 'owner@example.com' }]);
    const map = await hydrateCreatorsForIssues([
      { id: 'i1', createdById: 'u1', createdVia: 'mcp' },
    ]);
    expect(map.get('i1')).toEqual({
      creatorEmail: 'owner@example.com',
      creatorIsAgent: true,
      creatorLabel: FORGE_AGENT_LABEL,
    });
  });

  it('legacy NULL created_via row is treated as human', async () => {
    selectWhere.mockReturnValueOnce([{ id: 'u1', email: 'legacy@example.com' }]);
    const map = await hydrateCreatorsForIssues([{ id: 'i1', createdById: 'u1', createdVia: null }]);
    expect(map.get('i1')).toEqual({
      creatorEmail: 'legacy@example.com',
      creatorIsAgent: false,
      creatorLabel: 'legacy@example.com',
    });
  });

  it('creator not found in users never falls back to a raw id', async () => {
    selectWhere.mockReturnValueOnce([]);
    const map = await hydrateCreatorsForIssues([
      { id: 'i1', createdById: 'deleted-user', createdVia: 'web' },
    ]);
    expect(map.get('i1')).toEqual({
      creatorEmail: null,
      creatorIsAgent: false,
      creatorLabel: 'Unknown user',
    });
  });
});

describe('buildCreatedByCondition', () => {
  it('agent and a person-uuid produce distinct SQL conditions', () => {
    const agentCond = buildCreatedByCondition('agent');
    const personCond = buildCreatedByCondition('11111111-1111-1111-1111-111111111111');
    expect(agentCond).toBeDefined();
    expect(personCond).toBeDefined();
    expect(agentCond).not.toBe(personCond);
  });
});

/** Column names referenced anywhere in a drizzle SQL tree. */
function columnsOf(node: unknown, acc = new Set<string>()): Set<string> {
  const n = node as { queryChunks?: unknown[]; name?: string };
  if (n && typeof n.name === 'string' && !n.queryChunks) acc.add(n.name);
  if (n?.queryChunks) for (const chunk of n.queryChunks) columnsOf(chunk, acc);
  return acc;
}

describe('buildOriginCondition', () => {
  // cm:why keying the lane on created_via alone is the bug — a scheduled sweep writing through MCP records `mcp`, so its findings landed in the human Backlog lane (on forge-dev, every single one)
  it('detector keys off detector_key, not just created_via', () => {
    const cols = columnsOf(buildOriginCondition('detector'));
    expect(cols).toContain('detector_key');
    expect(cols).toContain('created_via');
  });

  it('human excludes anything carrying a detector_key', () => {
    const cols = columnsOf(buildOriginCondition('human'));
    expect(cols).toContain('detector_key');
    expect(cols).toContain('created_via');
  });

  it('the two lanes are complementary — neither is a subset of the other', () => {
    expect(buildOriginCondition('detector')).not.toEqual(buildOriginCondition('human'));
  });
});
