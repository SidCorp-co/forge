import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory mock of drizzle's chained query builder. Each describe spec
// pre-loads `selectQueue` with the row the next `select…limit(1)` should
// return; updates and inserts are recorded to `updateCalls` / `insertCalls`
// for assertion. Mirrors the style used in lifecycle-routes.test.ts.

type Row = Record<string, unknown> | undefined;

const selectQueue: Row[] = [];
const updateCalls: Array<{ table: string; set: Record<string, unknown> }> = [];
const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];

const tableNames = new WeakMap<object, string>();
function tagTable(name: string) {
  const t = {};
  tableNames.set(t, name);
  return t;
}

const agentSessions = tagTable('agent_sessions');
const issues = tagTable('issues');
const jobs = tagTable('jobs');

vi.mock('../db/schema.js', () => ({ agentSessions, issues, jobs }));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: (tbl: object) => ({
        where: () => ({
          limit: () => Promise.resolve(selectQueue.shift() ? [selectQueue.shift()!] : []),
        }),
      }),
    }),
    update: (tbl: object) => ({
      set: (s: Record<string, unknown>) => {
        updateCalls.push({ table: tableNames.get(tbl) ?? '?', set: s });
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    insert: (tbl: object) => ({
      values: (v: Record<string, unknown>) => {
        insertCalls.push({ table: tableNames.get(tbl) ?? '?', values: v });
        return { returning: () => Promise.resolve([{ id: 'sess-new' }]) };
      },
    }),
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: () => ({ _sql: 'eq' }),
}));

const publishMock = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => publishMock(...args) },
}));
vi.mock('../ws/rooms.js', () => ({
  deviceRoom: (id: string) => `device:${id}`,
  projectRoom: (id: string) => `project:${id}`,
}));

const { ensureAgentSessionForJob, syncAgentSessionLifecycle } = await import(
  './agent-session-link.js'
);

function pushSelect(row: Row) {
  // The mock pulls two values per select — the first is a sentinel, the
  // second is the actual row. Push twice so the stub returns `[row]`.
  selectQueue.push({}, row);
}

const baseJob = {
  id: 'job-1',
  projectId: 'proj-1',
  issueId: null,
  deviceId: 'dev-1',
  type: 'plan',
  payload: { skillName: 'forge-plan' },
  status: 'dispatched',
  retryOf: null,
  agentSessionId: null,
} as never;

describe('jobs/agent-session-link', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updateCalls.length = 0;
    insertCalls.length = 0;
    publishMock.mockReset();
  });

  describe('ensureAgentSessionForJob', () => {
    it('returns the existing session id when the job already has one (no-op)', async () => {
      const result = await ensureAgentSessionForJob(
        { ...baseJob, agentSessionId: 'sess-existing' } as never,
        { repoPath: '/r' },
      );
      expect(result).toBe('sess-existing');
      expect(insertCalls).toHaveLength(0);
      expect(updateCalls).toHaveLength(0);
    });

    it('reuses the parent session for a retry job', async () => {
      pushSelect({ agentSessionId: 'sess-parent' });
      const result = await ensureAgentSessionForJob({ ...baseJob, retryOf: 'job-0' } as never, {
        repoPath: '/r',
      });
      expect(result).toBe('sess-parent');
      // 1) flip parent session back to running, 2) link this job to parent's session
      expect(updateCalls.map((c) => c.table)).toEqual(['agent_sessions', 'jobs']);
      expect(updateCalls[0]?.set.status).toBe('running');
      expect(updateCalls[1]?.set.agentSessionId).toBe('sess-parent');
      expect(insertCalls).toHaveLength(0);
    });

    it('creates a new agent_sessions row when the job has no parent session', async () => {
      pushSelect({ title: 'Fix login bug', createdById: 'user-1' });
      const result = await ensureAgentSessionForJob({ ...baseJob, issueId: 'iss-1' } as never, {
        repoPath: '/r',
      });
      expect(result).toBe('sess-new');
      expect(insertCalls).toHaveLength(1);
      const inserted = insertCalls[0];
      expect(inserted?.table).toBe('agent_sessions');
      expect(inserted?.values.projectId).toBe('proj-1');
      expect(inserted?.values.userId).toBe('user-1');
      expect(inserted?.values.status).toBe('running');
      expect(inserted?.values.title).toContain('forge-plan');
      expect(inserted?.values.title).toContain('Fix login bug');
      const meta = inserted?.values.metadata as Record<string, unknown>;
      expect(meta.type).toBe('pipeline');
      expect(meta.jobId).toBe('job-1');
      expect(meta.issueId).toBe('iss-1');
      expect(meta.skillName).toBe('forge-plan');
      // links the job to the new session
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]?.set.agentSessionId).toBe('sess-new');
      // broadcasts created event
      expect(publishMock).toHaveBeenCalled();
    });

    it("tags pm jobs with metadata.type='pm' so the pm session filter scopes them", async () => {
      // No issue lookup for project-scoped pm jobs (issueId stays null).
      const result = await ensureAgentSessionForJob(
        { ...baseJob, type: 'pm', payload: {}, issueId: null } as never,
        { repoPath: '/r' },
      );
      expect(result).toBe('sess-new');
      expect(insertCalls).toHaveLength(1);
      const meta = insertCalls[0]?.values.metadata as Record<string, unknown>;
      expect(meta.type).toBe('pm');
      expect(meta.jobType).toBe('pm');
    });

    it("keeps metadata.type='pipeline' for non-pm job types", async () => {
      pushSelect({ title: 'Bug', createdById: 'user-1' });
      await ensureAgentSessionForJob({ ...baseJob, type: 'code', issueId: 'iss-2' } as never, {
        repoPath: '/r',
      });
      const meta = insertCalls[0]?.values.metadata as Record<string, unknown>;
      expect(meta.type).toBe('pipeline');
      expect(meta.jobType).toBe('code');
    });
  });

  describe('syncAgentSessionLifecycle', () => {
    it('no-ops when the job has no linked session', async () => {
      await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: null } as never, 'done');
      expect(updateCalls).toHaveLength(0);
      expect(publishMock).not.toHaveBeenCalled();
    });

    it('maps done → completed', async () => {
      await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: 'sess-1' } as never, 'done');
      expect(updateCalls[0]?.set.status).toBe('completed');
    });

    it('maps cancelled → completed (enum has no cancelled)', async () => {
      await syncAgentSessionLifecycle(
        { ...baseJob, agentSessionId: 'sess-1' } as never,
        'cancelled',
      );
      expect(updateCalls[0]?.set.status).toBe('completed');
    });

    it('maps failed → failed', async () => {
      await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: 'sess-1' } as never, 'failed');
      expect(updateCalls[0]?.set.status).toBe('failed');
    });
  });
});
