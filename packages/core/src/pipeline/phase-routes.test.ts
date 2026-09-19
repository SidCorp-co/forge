/**
 * The phase journal over REST — what a shell holding only a PAT can declare.
 *
 * `forge_phase` was parked as MCP-only on the rationale "session lifecycle
 * hook, not a data query". These cases are the counter-evidence: every input
 * the write needs is `(run, phase, attempt)`, and the project comes from the
 * run rather than the caller.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const readPipelineRun = vi.fn();
const loadProjectAccess = vi.fn();
const startPhase = vi.fn();
const endPhase = vi.fn();
const resumePoint = vi.fn();
const listPhases = vi.fn();

vi.mock('./runs.js', () => ({ readPipelineRun }));
vi.mock('./phase-journal.js', () => ({ startPhase, endPhase, resumePoint, listPhases }));
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess,
  assertProjectRole: (access: { role?: string }, need: 'viewer' | 'member') => {
    const rank: Record<string, number> = { viewer: 1, member: 2, admin: 3 };
    if ((rank[access.role ?? ''] ?? 0) < (rank[need] ?? 0)) {
      throw new Error(`FORBIDDEN: needs ${need}`);
    }
  },
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: () => async (c: { set: (k: string, v: string) => void }, next: () => unknown) => {
    c.set('userId', 'u1');
    return next();
  },
  assertEmailVerified: () => async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

const { phaseRoutes } = await import('./phase-routes.js');

const RUN = 'a3f1c2d4-5e6b-4a7c-8d9e-0f1a2b3c4d5e';
const ISSUE = 'b4e2d3c5-6f7a-4b8d-9e0f-1a2b3c4d5e6f';

const json = (path: string, body: unknown) =>
  phaseRoutes.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  readPipelineRun.mockResolvedValue({ id: RUN, projectId: 'p1', issueId: ISSUE });
  loadProjectAccess.mockResolvedValue({ role: 'member' });
  startPhase.mockResolvedValue({ phase: 'code', attempt: 2, startedAt: new Date(0) });
  resumePoint.mockResolvedValue(null);
  listPhases.mockResolvedValue([]);
});

describe('POST /:id/phases', () => {
  it('returns the attempt the journal assigned, so a re-entered phase is a new round', async () => {
    const res = await json(`/${RUN}/phases`, { phase: 'code' });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ phase: 'code', attempt: 2 });
  });

  it('takes the project and the issue FROM the run, not from the caller', async () => {
    await json(`/${RUN}/phases`, { phase: 'code' });
    expect(loadProjectAccess).toHaveBeenCalledWith('p1', 'u1');
    expect(startPhase).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', runId: RUN, issueId: ISSUE }),
    );
  });

  it('404s on a run that does not exist rather than writing an orphan row', async () => {
    readPipelineRun.mockResolvedValue(null);
    const res = await json(`/${RUN}/phases`, { phase: 'code' });
    expect(res.status).toBe(404);
    expect(startPhase).not.toHaveBeenCalled();
  });

  it('refuses a viewer — declaring a phase is a write', async () => {
    loadProjectAccess.mockResolvedValue({ role: 'viewer' });
    const res = await json(`/${RUN}/phases`, { phase: 'code' });
    expect(res.status).not.toBe(201);
    expect(startPhase).not.toHaveBeenCalled();
  });
});

describe('POST /:id/phases/end', () => {
  it('closes the attempt it is given', async () => {
    const res = await json(`/${RUN}/phases/end`, { phase: 'code', attempt: 2, outcome: 'ok' });
    expect(res.status).toBe(200);
    expect(endPhase).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN, phase: 'code', attempt: 2, outcome: 'ok' }),
    );
  });

  it('carries a note as the only artifact shape it will write', async () => {
    await json(`/${RUN}/phases/end`, { phase: 'ship', attempt: 1, outcome: 'ok', note: 'shipped' });
    expect(endPhase).toHaveBeenCalledWith(
      expect.objectContaining({ artifact: { kind: 'note', text: 'shipped' } }),
    );
  });

  it('rejects a caller-supplied artifact — this is the driver writing its own verdict', async () => {
    const res = await json(`/${RUN}/phases/end`, {
      phase: 'review',
      attempt: 1,
      outcome: 'ok',
      artifact: { kind: 'verdict', decision: 'approve' },
    });
    expect(res.status).toBe(400);
    expect(endPhase).not.toHaveBeenCalled();
  });

  it('rejects an outcome outside the journal enum', async () => {
    const res = await json(`/${RUN}/phases/end`, {
      phase: 'code',
      attempt: 1,
      outcome: 'approved',
    });
    expect(res.status).toBe(400);
    expect(endPhase).not.toHaveBeenCalled();
  });
});

describe('GET /:id/resume-point', () => {
  it('answers null when nothing is open, so a fresh session starts at phase 1', async () => {
    const res = await phaseRoutes.request(`/${RUN}/resume-point`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ resumePoint: null });
  });

  it('answers the newest unended phase', async () => {
    resumePoint.mockResolvedValue({ phase: 'code', attempt: 3, startedAt: new Date(0) });
    const res = await phaseRoutes.request(`/${RUN}/resume-point`);
    await expect(res.json()).resolves.toMatchObject({
      resumePoint: { phase: 'code', attempt: 3 },
    });
  });

  it('a viewer may read the resume point', async () => {
    loadProjectAccess.mockResolvedValue({ role: 'viewer' });
    const res = await phaseRoutes.request(`/${RUN}/resume-point`);
    expect(res.status).toBe(200);
  });
});

/**
 * ISS-1042 criterion 40 — a run's journal is readable in order.
 *
 * `resume-point` answered where to restart and was the only way in, so an
 * operator could read what a run was stuck on and never what it had done. The
 * ordering itself belongs to `listPhases` and is asserted against real rows in
 * the integration suite; what this file owns is that the route exists, answers
 * a viewer, and passes the rows through without reshaping them into a summary.
 */
describe('GET /:id/phases', () => {
  const rows = [
    {
      phase: 'code',
      attempt: 1,
      source: 'agent',
      outcome: 'failed',
      startedAt: new Date(0),
      endedAt: new Date(1),
      artifact: { kind: 'note', text: 'the build broke' },
    },
    {
      phase: 'code',
      attempt: 2,
      source: 'agent',
      outcome: null,
      startedAt: new Date(2),
      endedAt: null,
      artifact: null,
    },
  ];

  it('answers the whole journal in the order the reader was given it', async () => {
    listPhases.mockResolvedValue(rows);

    const res = await phaseRoutes.request(`/${RUN}/phases`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { phases: Array<{ phase: string; attempt: number }> };
    expect(body.phases.map((p) => [p.phase, p.attempt])).toEqual([
      ['code', 1],
      ['code', 2],
    ]);
  });

  it('carries each phase’s outcome and its artifact through', async () => {
    listPhases.mockResolvedValue(rows);

    const body = (await (await phaseRoutes.request(`/${RUN}/phases`)).json()) as {
      phases: Array<Record<string, unknown>>;
    };

    expect(body.phases[0]).toMatchObject({
      outcome: 'failed',
      source: 'agent',
      artifact: { kind: 'note', text: 'the build broke' },
    });
    expect(body.phases[1]).toMatchObject({ outcome: null, endedAt: null });
  });

  it('answers a viewer', async () => {
    loadProjectAccess.mockResolvedValue({ role: 'viewer' });

    expect((await phaseRoutes.request(`/${RUN}/phases`)).status).toBe(200);
  });

  it('404s on a run that does not exist rather than answering an empty journal', async () => {
    readPipelineRun.mockResolvedValue(null);

    const res = await phaseRoutes.request(`/${RUN}/phases`);

    expect(res.status).toBe(404);
    expect(listPhases).not.toHaveBeenCalled();
  });
});
