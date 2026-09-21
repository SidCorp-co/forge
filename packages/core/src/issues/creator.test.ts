import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

type WriterRow = { id: string; email: string; displayName: string | null; kind: string };

const selectWhere = vi.fn((): WriterRow[] => []);
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

const {
  creatorIsAgentCondition,
  hydrateCreatorsForIssues,
  buildCreatedByCondition,
  buildOriginCondition,
} = await import('./creator.js');

const person = (over: Partial<WriterRow> = {}): WriterRow => ({
  id: 'u1',
  email: 'owner@example.com',
  displayName: null,
  kind: 'human',
  ...over,
});

/**
 * ISS-1137 — the writer's own account answers, and nothing else does.
 *
 * Each case below is a row whose `users.kind` is the ONLY thing that decides
 * it. `created_via` is not an input to this function any more, so a case that
 * carried one would be asserting against a column nothing reads.
 */
describe('hydrateCreatorsForIssues', () => {
  it('empty input skips the query', async () => {
    const map = await hydrateCreatorsForIssues([]);
    expect(map.size).toBe(0);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('a person with no display name is labelled by their address', async () => {
    selectWhere.mockReturnValueOnce([person()]);
    const map = await hydrateCreatorsForIssues([{ id: 'i1', createdById: 'u1' }]);
    expect(map.get('i1')).toEqual({
      creatorEmail: 'owner@example.com',
      creatorIsAgent: false,
      creatorLabel: 'owner@example.com',
    });
  });

  it('a person with a display name is labelled by it', async () => {
    selectWhere.mockReturnValueOnce([person({ displayName: 'Ada Lovelace' })]);
    const map = await hydrateCreatorsForIssues([{ id: 'i1', createdById: 'u1' }]);
    expect(map.get('i1')?.creatorLabel).toBe('Ada Lovelace');
    expect(map.get('i1')?.creatorIsAgent).toBe(false);
  });

  it('an agent account is labelled by the name its org admin gave it', async () => {
    selectWhere.mockReturnValueOnce([
      person({ id: 'a1', email: 'master@agents.local', displayName: 'master', kind: 'agent' }),
    ]);
    const map = await hydrateCreatorsForIssues([{ id: 'i1', createdById: 'a1' }]);
    expect(map.get('i1')).toEqual({
      creatorEmail: 'master@agents.local',
      creatorIsAgent: true,
      creatorLabel: 'master',
    });
  });

  // The case a shared class label cannot express: two agents on one page.
  it('two agent accounts on one page keep two different names', async () => {
    selectWhere.mockReturnValueOnce([
      person({ id: 'a1', email: 'one@agents.local', displayName: 'master', kind: 'agent' }),
      person({ id: 'a2', email: 'two@agents.local', displayName: 'reviewer', kind: 'agent' }),
    ]);
    const map = await hydrateCreatorsForIssues([
      { id: 'i1', createdById: 'a1' },
      { id: 'i2', createdById: 'a2' },
    ]);
    expect(map.get('i1')?.creatorLabel).toBe('master');
    expect(map.get('i2')?.creatorLabel).toBe('reviewer');
    expect(map.get('i1')?.creatorIsAgent).toBe(true);
    expect(map.get('i2')?.creatorIsAgent).toBe(true);
  });

  it('an agent with no display name falls back to its address, not to a class label', async () => {
    selectWhere.mockReturnValueOnce([
      person({ id: 'a1', email: 'nameless@agents.local', kind: 'agent' }),
    ]);
    expect((await hydrateCreatorsForIssues([{ id: 'i1', createdById: 'a1' }])).get('i1')).toEqual({
      creatorEmail: 'nameless@agents.local',
      creatorIsAgent: true,
      creatorLabel: 'nameless@agents.local',
    });
  });

  it('creator not found in users never falls back to a raw id', async () => {
    selectWhere.mockReturnValueOnce([]);
    const map = await hydrateCreatorsForIssues([{ id: 'i1', createdById: 'deleted-user' }]);
    expect(map.get('i1')).toEqual({
      creatorEmail: null,
      creatorIsAgent: false,
      creatorLabel: 'Unknown user',
    });
  });
});

describe('creatorIsAgentCondition', () => {
  it('asks the users table and reads no channel column', () => {
    const cols = columnsOf(creatorIsAgentCondition());
    expect(cols).toContain('kind');
    expect(cols).toContain('created_by_id');
    expect(cols).not.toContain('created_via');
    expect(cols).not.toContain('creator_agency');
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

  // The `AND NOT (agent)` half is gone: a writer id now selects that writer's
  // rows whatever kind the writer is, because no id carries another's rows.
  it("one writer's filter reads that writer's id and nothing about kind", () => {
    const cols = columnsOf(buildCreatedByCondition('11111111-1111-1111-1111-111111111111'));
    expect(cols).toContain('created_by_id');
    expect(cols).not.toContain('kind');
  });

  it('the agent filter is the kind condition itself', () => {
    expect(columnsOf(buildCreatedByCondition('agent'))).toEqual(
      columnsOf(creatorIsAgentCondition()),
    );
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
