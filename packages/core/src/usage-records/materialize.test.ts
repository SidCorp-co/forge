import { beforeEach, describe, expect, it, vi } from 'vitest';

// DB mock: select(...).from(...).where(...).orderBy(...) resolves to events;
// insert(...).values(...).onConflictDoNothing() records the insert.
const orderBy = vi.fn();
const where = vi.fn(() => ({ orderBy }));
const from = vi.fn(() => ({ where }));
const onConflictDoNothing = vi.fn(() => Promise.resolve());
const values = vi.fn((_row: Record<string, unknown>) => ({ onConflictDoNothing }));
const insert = vi.fn(() => ({ values }));
const select = vi.fn(() => ({ from }));

vi.mock('../db/client.js', () => ({ db: { select, insert } }));

const { materializeJobUsage } = await import('./materialize.js');

const TS = new Date('2026-06-10T12:00:00Z');
function resultEvents() {
  return [
    {
      kind: 'stdout',
      ts: TS,
      data: {
        line: {
          type: 'result',
          total_cost_usd: 3.5,
          num_turns: 12,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 2,
          },
          modelUsage: { 'claude-opus-4-8': { inputTokens: 100, outputTokens: 20 } },
        },
      },
    },
  ];
}

beforeEach(() => {
  orderBy.mockReset();
  select.mockClear();
  from.mockClear();
  where.mockClear();
  values.mockClear();
  insert.mockClear();
  onConflictDoNothing.mockClear();
});

describe('materializeJobUsage', () => {
  const job = { id: 'job-1', agentSessionId: 'sess-1', projectId: 'proj-1' };

  it('inserts a cli usage row keyed to the job + session, conflict-safe', async () => {
    orderBy.mockResolvedValueOnce(resultEvents());
    await materializeJobUsage(job);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledTimes(1);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    const row = values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      projectId: 'proj-1',
      source: 'cli',
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 2,
      estimatedCost: 3.5,
      requestCount: 12,
      sessionId: 'sess-1',
      jobId: 'job-1',
    });
    expect(row.recordedAt).toEqual(TS);
  });

  it('skips jobs with no agent_session_id (no query, no insert)', async () => {
    await materializeJobUsage({ id: 'job-2', agentSessionId: null, projectId: 'proj-1' });
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('does not insert when there is no result line (e.g. desktop job)', async () => {
    orderBy.mockResolvedValueOnce([{ kind: 'progress', ts: TS, data: { claudeSessionId: 'x' } }]);
    await materializeJobUsage(job);
    expect(insert).not.toHaveBeenCalled();
  });

  it('never throws on a DB error (best-effort)', async () => {
    orderBy.mockRejectedValueOnce(new Error('db down'));
    await expect(materializeJobUsage(job)).resolves.toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
  });
});
