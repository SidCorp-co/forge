import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';
const calls: { bulk: boolean; scope: unknown[]; channel: string }[] = [];
const held: string[] = [];
let writable: { id: string }[] = [];

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('./triage.js', () => ({
  triageReports: async (input: { bulk: boolean; scope: unknown[]; channel: string }) => {
    calls.push(input);
    return {
      ok: true,
      effect: { act: 'dismiss', triage: 'dismissed', reports: ['r1'], issue: null, untouched: [] },
    };
  },
}));
vi.mock('./service.js', () => ({
  readReport: async () => null,
  visibleIssue: async () => null,
  writableProjectIds: (rows: { id: string }[]) => rows.map((r) => r.id),
}));
vi.mock('./reports.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readOneReport: async () => ({ id: 'r1' }),
}));
vi.mock('../projects/index.js', () => ({ listVisibleProjectsWithRole: async () => writable }));
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: async (projectId: string) => ({ projectId }),
  loadVisibleProjectIds: async () => [P1, P2],
}));
vi.mock('../permissions/index.js', () => ({
  requireHeld: (access: { projectId: string }, permission: string) => {
    held.push(`${permission}@${access.projectId}`);
  },
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.set('userId', 'u1');
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  restActor: () => ({ type: 'user', id: 'u1', agency: 'agent' }),
}));

const { agentReportRoutes } = await import('./routes.js');

function app() {
  const a = new Hono().route('/api/agent-reports', agentReportRoutes);
  a.onError(errorHandler as never);
  return a;
}

const post = (body: unknown) =>
  app().request('/api/agent-reports/triage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  calls.length = 0;
  held.length = 0;
  writable = [{ id: P1 }];
});

describe('automation dismiss: bulk triage by signalKey has a REST door', () => {
  it('triages every report of one signal in a project, after project.write is held there', async () => {
    const res = await post({
      signalKey: 'skill:forge-test',
      projectId: P1,
      triage: { act: 'dismiss', reason: 'fixed upstream' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { effect: { reports: string[] } }).effect.reports).toEqual([
      'r1',
    ]);
    expect(held).toEqual([`project.write@${P1}`]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bulk).toBe(true);
    expect(calls[0]?.scope).toHaveLength(2);
  });

  it('scope all reaches every project the caller can write, without naming one', async () => {
    writable = [{ id: P1 }, { id: P2 }];
    const res = await post({ signalKey: 's', scope: 'all', triage: { act: 'reopen' } });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(held).toEqual([]);
  });

  it('refuses AGENT_REPORT_BULK_PROJECT_REQUIRED when scope project names no project', async () => {
    const res = await post({ signalKey: 's', triage: { act: 'reopen' } });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(422);
    expect(body.error?.code).toBe('AGENT_REPORT_BULK_PROJECT_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('refuses AGENT_REPORT_BULK_CREATE_ACROSS_PROJECTS for createIssue over scope all', async () => {
    const res = await post({
      signalKey: 's',
      scope: 'all',
      triage: { act: 'file', createIssue: { title: 'one defect' } },
    });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(422);
    expect(body.error?.code).toBe('AGENT_REPORT_BULK_CREATE_ACROSS_PROJECTS');
    expect(calls).toHaveLength(0);
  });

  it('refuses AGENT_REPORT_NO_WRITABLE_PROJECT rather than answering an empty triage', async () => {
    writable = [];
    const res = await post({ signalKey: 's', scope: 'all', triage: { act: 'reopen' } });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(422);
    expect(body.error?.code).toBe('AGENT_REPORT_NO_WRITABLE_PROJECT');
    expect(calls).toHaveLength(0);
  });

  it('refuses an unknown body key by name', async () => {
    const res = await post({
      signalKey: 's',
      projectId: P1,
      reportId: P2,
      triage: { act: 'reopen' },
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/agent-reports/:id is gone (no caller; the web reads one report under automation)', () => {
  it('answers 404', async () => {
    const res = await app().request(`/api/agent-reports/${P1}`);
    expect(res.status).toBe(404);
  });
});
