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
  creatorIsAgent,
  creatorIsAgentCondition,
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
      { id: 'i1', createdById: 'u1', createdVia: 'web', creatorAgency: null },
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
      { id: 'i1', createdById: 'u1', createdVia: 'mcp', creatorAgency: null },
    ]);
    expect(map.get('i1')).toEqual({
      creatorEmail: 'owner@example.com',
      creatorIsAgent: true,
      creatorLabel: FORGE_AGENT_LABEL,
    });
  });

  it('legacy NULL created_via row is treated as human', async () => {
    selectWhere.mockReturnValueOnce([{ id: 'u1', email: 'legacy@example.com' }]);
    const map = await hydrateCreatorsForIssues([
      { id: 'i1', createdById: 'u1', createdVia: null, creatorAgency: null },
    ]);
    expect(map.get('i1')).toEqual({
      creatorEmail: 'legacy@example.com',
      creatorIsAgent: false,
      creatorLabel: 'legacy@example.com',
    });
  });

  it('creator not found in users never falls back to a raw id', async () => {
    selectWhere.mockReturnValueOnce([]);
    const map = await hydrateCreatorsForIssues([
      { id: 'i1', createdById: 'deleted-user', createdVia: 'web', creatorAgency: null },
    ]);
    expect(map.get('i1')).toEqual({
      creatorEmail: null,
      creatorIsAgent: false,
      creatorLabel: 'Unknown user',
    });
  });
});

/**
 * ISS-1093 — the credential answers, the channel is only the pre-column floor.
 *
 * Every case here is a pair (`creator_agency`, `created_via`) whose two halves
 * disagree, because a case where they agree cannot tell the two readings apart.
 */
describe('creatorIsAgent', () => {
  it('a stored agent beats a web channel — the reported shape: an agent on a person PAT through REST', () => {
    expect(creatorIsAgent({ creatorAgency: 'agent', createdVia: 'web' })).toBe(true);
  });

  // cm:guard THE case an OR cannot express, and the reason this reader is not `activity-routes.ts:isAgentForRow`. Rewrite `creatorIsAgent` as `agency === 'agent' || isAgentChannel(via)` and this line goes red on its own: the stored `human` is discarded and the channel decides again, which is the whole defect the column was added to end.
  it('a stored human beats an agent channel', () => {
    expect(creatorIsAgent({ creatorAgency: 'human', createdVia: 'mcp' })).toBe(false);
  });

  it('NULL falls back to the channel, so a pre-column agent-channel row is unchanged', () => {
    expect(creatorIsAgent({ creatorAgency: null, createdVia: 'mcp' })).toBe(true);
  });

  it('NULL falls back to the channel, so a pre-column web row is unchanged', () => {
    expect(creatorIsAgent({ creatorAgency: null, createdVia: 'web' })).toBe(false);
  });

  it('NULL on both is human, which is what a legacy row with no channel always read as', () => {
    expect(creatorIsAgent({ creatorAgency: null, createdVia: null })).toBe(false);
  });
});

describe('creatorIsAgentCondition', () => {
  // cm:guard the fragment's top level is an OR spliced raw into its caller, so without its own
  // parentheses `and(status, cond)` binds as `status AND a='agent' OR (...)` and the filter returns
  // agent rows of every other status. Drop the outer pair in `creator.ts` and this goes red.
  it('is parenthesised as a whole, so an AND-composing caller cannot re-bind it', () => {
    const chunks = (creatorIsAgentCondition() as unknown as { queryChunks: unknown[] }).queryChunks;
    const text = chunks
      .map((c) =>
        typeof c === 'object' && c && 'value' in c ? String((c as { value: unknown }).value) : '',
      )
      .join('');
    expect(text.trimStart().startsWith('(')).toBe(true);
    expect(text.trimEnd().endsWith(')')).toBe(true);
  });

  it('reads both columns, so a row with a stored agency is matched on it', () => {
    const cols = columnsOf(creatorIsAgentCondition());
    expect(cols).toContain('creator_agency');
    expect(cols).toContain('created_via');
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

  // cm:guard the person branch is the NEGATION of the label predicate, not a second spelling of it.
  // A person-uuid filter that still reads only `created_via` surfaces the rows the list shows as
  // Forge Agent under that person's own name — display and filter drifting apart is what ISS-756
  // fixed for the channel and ISS-1093 has to keep fixed for the column.
  it("a person's rows exclude what the list marks as an agent's, read off the same column", () => {
    const cols = columnsOf(buildCreatedByCondition('11111111-1111-1111-1111-111111111111'));
    expect(cols).toContain('creator_agency');
    expect(cols).toContain('created_by_id');
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
