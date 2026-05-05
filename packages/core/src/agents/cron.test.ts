import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

const spawnMock = vi.fn(async () => ({ ok: true, jobId: 'pm-1' }) as const);
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
      where: async () => rows,
    }),
  }));
}

beforeEach(() => {
  selectMock.mockReset();
  spawnMock.mockClear();
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

  it('continues if spawn throws for one agent', async () => {
    queueAgents([
      { id: 'agent-1', projectId: 'p1', type: 'po', schedule: 'weekly' },
      { id: 'agent-2', projectId: 'p2', type: 'po', schedule: 'weekly' },
    ]);
    spawnMock.mockRejectedValueOnce(new Error('boom'));
    const fired = await runAgentCronTickOnce(MONDAY_2026_05_04);
    expect(fired).toEqual(['agent-2']);
  });
});
