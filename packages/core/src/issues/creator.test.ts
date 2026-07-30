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

const { isAgentChannel, hydrateCreatorsForIssues, buildCreatedByCondition, FORGE_AGENT_LABEL } =
  await import('./creator.js');

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
