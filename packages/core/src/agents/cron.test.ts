import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
let lastWhereArg: unknown = undefined;
vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

// Recursively scan a drizzle SQL value (or any nested object) for an exact
// string match. Used to assert that the WHERE clause references particular
// column names without being coupled to drizzle's internal SQL shape.
function findString(node: unknown, target: string, depth = 0): boolean {
  if (depth > 12 || node == null) return false;
  if (typeof node === 'string') return node === target;
  if (typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((v) => findString(v, target, depth + 1));
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (findString(v, target, depth + 1)) return true;
  }
  return false;
}

const spawnMock = vi.fn(async (..._args: unknown[]) => ({ ok: true, jobId: 'pm-1' }) as const);
vi.mock('../pm/spawner.js', () => ({
  spawnPmSession: (...args: unknown[]) => spawnMock(...(args as [unknown])),
}));

vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async () => 'worker-1'),
    schedule: vi.fn(async () => {}),
    unschedule: vi.fn(async () => {}),
    offWork: vi.fn(async () => {}),
  },
}));

const { runAgentCronTickOnce } = await import('./cron.js');

interface AgentRow {
  id: string;
  projectId: string;
  type: string;
  schedule: 'off' | 'weekly' | 'biweekly' | 'monthly';
}

function queueAgents(rows: AgentRow[]): void {
  selectMock.mockImplementationOnce(() => ({
    from: () => ({
      where: async (cond: unknown) => {
        lastWhereArg = cond;
        return rows;
      },
    }),
  }));
}

beforeEach(() => {
  selectMock.mockReset();
  spawnMock.mockClear();
  lastWhereArg = undefined;
});

const MONDAY_2026_05_04 = new Date('2026-05-04T00:00:00Z');
const TUESDAY_2026_05_05 = new Date('2026-05-05T00:00:00Z');

describe('runAgentCronTickOnce', () => {
  it('weekly + enabled agent fires on Monday', async () => {
    queueAgents([
      { id: 'agent-1', projectId: 'proj-1', type: 'po', schedule: 'weekly' },
    ]);
    const fired = await runAgentCronTickOnce(MONDAY_2026_05_04);
    expect(fired).toEqual(['agent-1']);
    expect(spawnMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      cause: 'agent-cron',
      eventRef: { agentId: 'agent-1', agentType: 'po', schedule: 'weekly' },
    });
  });

  it('weekly agent does not fire on Tuesday', async () => {
    queueAgents([
      { id: 'agent-1', projectId: 'proj-1', type: 'po', schedule: 'weekly' },
    ]);
    const fired = await runAgentCronTickOnce(TUESDAY_2026_05_05);
    expect(fired).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not include agents where spawn returns ok:false (e.g. already-active)', async () => {
    queueAgents([
      { id: 'agent-1', projectId: 'proj-1', type: 'po', schedule: 'weekly' },
    ]);
    spawnMock.mockResolvedValueOnce({ ok: false, reason: 'already-active' } as never);
    const fired = await runAgentCronTickOnce(MONDAY_2026_05_04);
    expect(fired).toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('skips disabled / off agents at the SQL level (filter)', async () => {
    // The SELECT is filtered to enabled=true AND schedule != 'off' — the
    // runtime should never see those rows. Simulate by passing only the rows
    // the DB would return; spawn must be called for each.
    queueAgents([
      { id: 'agent-w', projectId: 'p', type: 'po', schedule: 'weekly' },
      { id: 'agent-m', projectId: 'p', type: 'po', schedule: 'monthly' },
    ]);
    // Use 2026-05-04 (Mon) — weekly fires, monthly does not (day 4).
    const fired = await runAgentCronTickOnce(MONDAY_2026_05_04);
    expect(fired).toEqual(['agent-w']);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("WHERE clause filters by enabled=true AND schedule != 'off' (regression guard)", async () => {
    // Pin the SQL filter so a future refactor that drops `enabled=true` or the
    // `schedule != 'off'` predicate fails this test. Runtime only checks
    // `shouldRunToday`, so without the SQL filter, disabled agents would leak
    // through on a Monday — the real DB column names must appear in the chunks.
    queueAgents([]);
    await runAgentCronTickOnce(MONDAY_2026_05_04);
    expect(lastWhereArg).toBeDefined();
    expect(findString(lastWhereArg, 'enabled')).toBe(true);
    expect(findString(lastWhereArg, 'schedule')).toBe(true);
  });

  it('continues if spawn throws for one agent', async () => {
    queueAgents([
      { id: 'agent-1', projectId: 'p1', type: 'po', schedule: 'weekly' },
      { id: 'agent-2', projectId: 'p2', type: 'po', schedule: 'weekly' },
    ]);
    spawnMock.mockRejectedValueOnce(new Error('boom'));
    const fired = await runAgentCronTickOnce(MONDAY_2026_05_04);
    expect(fired).toEqual(['agent-2']);
  });

  it('UC-5: two ticks in the same day → only one effective spawn (already-active resolves the second)', async () => {
    // First tick → spawn returns ok:true; second tick → existing
    // jobs_pm_per_project_unique_idx forces spawnPmSession to return
    // {ok:false, reason:'already-active'}. The cron must propagate that as a
    // no-op (no duplicate fired entry) without throwing.
    queueAgents([
      { id: 'agent-1', projectId: 'proj-1', type: 'po', schedule: 'weekly' },
    ]);
    const first = await runAgentCronTickOnce(MONDAY_2026_05_04);
    expect(first).toEqual(['agent-1']);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    queueAgents([
      { id: 'agent-1', projectId: 'proj-1', type: 'po', schedule: 'weekly' },
    ]);
    spawnMock.mockResolvedValueOnce({ ok: false, reason: 'already-active' } as never);
    const second = await runAgentCronTickOnce(MONDAY_2026_05_04);
    expect(second).toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
