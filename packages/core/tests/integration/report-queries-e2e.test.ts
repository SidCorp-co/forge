import { ReportRunSchema } from '@forge/contracts/report-queries';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';

// The report-queries door: a query runs as the caller, over what the caller may read, and its
// result says which query, which params and which read produced it (REQ-32, lane A2).

const detail = (res: { body: Body }) =>
  String(res.body.detail ?? (res.body.error as Body | undefined)?.message);

describe('the report-queries door', () => {
  let w: World;
  let viewerToken: string;
  let strangerToken: string;
  const run = (token: string | null, queryId: string, body: unknown = {}, project = w.projectId) =>
    api(token, 'POST', `/api/projects/${project}/report-queries/${queryId}/runs`, body);

  beforeAll(async () => {
    w = await world();
    const viewer = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, viewer.id, 'viewer');
    viewerToken = await userToken(viewer.id);
    strangerToken = await userToken((await createTestUser({ verified: true })).id);
  }, 120_000);

  it('lists the registered queries with their params as JSON Schema and the fields they return', async () => {
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/report-queries`);
    expect(res.status).toBe(200);
    const queries = res.body.queries as Body[];
    expect(queries.map((q) => q.id).sort()).toEqual([
      'criteria-coverage',
      'progress-by-requirement',
      'release-readiness',
      'roadmap-eta',
      'workflow-status',
    ]);
    const progress = queries.find((q) => q.id === 'progress-by-requirement') as Body;
    expect(progress).toMatchObject({ version: 1, permission: 'project.read', egress: 'product' });
    expect((progress.params as Body).additionalProperties).toBe(false);
    expect((progress.output as Body[]).map((f) => f.name)).toContain('criteriaProven');
  });

  it('refuses the list to a caller who is not signed in, and to one who is not a member', async () => {
    const path = `/api/projects/${w.projectId}/report-queries`;
    expect((await api(null, 'GET', path)).status).toBe(401);
    expect((await api(strangerToken, 'GET', path)).status).toBe(403);
  });

  it('runs a query as the caller and answers a run that carries its provenance', async () => {
    const res = await run(w.token, 'progress-by-requirement');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const parsed = ReportRunSchema.parse(res.body);
    expect(parsed).toMatchObject({
      queryId: 'progress-by-requirement',
      version: 1,
      params: {},
      projectId: w.projectId,
      actor: { kind: 'human', id: w.userId },
    });
    expect(Math.abs(Date.now() - Date.parse(parsed.asOf))).toBeLessThan(60_000);
  });

  it('answers the same rows as the status read it summarises', async () => {
    const status = (await api(w.token, 'GET', `/api/projects/${w.projectId}/status`)).body;
    const items = (status.requirements as Body).items as Body[];
    const frame = (await run(w.token, 'progress-by-requirement')).body.frame as Body;
    expect((frame.rows as Body[]).map((r) => r.key)).toEqual(items.map((i) => i.key));
    const roadmap = status.roadmap as Record<'now' | 'next' | 'later', Body[]>;
    const eta = (await run(w.token, 'roadmap-eta')).body.frame as Body;
    expect((eta.rows as Body[]).map((r) => r.key)).toEqual(
      [...roadmap.now, ...roadmap.next, ...roadmap.later].map((i) => i.key),
    );
  });

  it('lets a viewer run it, since a viewer holds the project.read the query declares', async () => {
    expect((await run(viewerToken, 'roadmap-eta')).status).toBe(200);
  });

  it('refuses a caller who is no member of the project, by name, and runs nothing', async () => {
    const res = await run(strangerToken, 'progress-by-requirement');
    expect(res.status).toBe(403);
    expect(detail(res)).toContain('not a member of this project');
  });

  it('refuses an unknown query, naming the ones that exist', async () => {
    const res = await run(w.token, 'burndown');
    expect(res.status).toBe(404);
    expect(detail(res)).toBe(
      'report query "burndown" is not registered; registered: progress-by-requirement, roadmap-eta, release-readiness, criteria-coverage, workflow-status',
    );
  });

  it('refuses a param the query does not declare, and a value outside its set, by name', async () => {
    const unknown = await run(w.token, 'roadmap-eta', { params: { lanes: 'now' } });
    expect(unknown.status).toBe(400);
    expect(detail(unknown)).toBe(
      'report query "roadmap-eta": params refused: Unrecognized key: "lanes"',
    );
    const wrong = await run(w.token, 'roadmap-eta', { params: { lane: 'soon' } });
    expect(wrong.status).toBe(400);
    expect(detail(wrong)).toMatch(/^report query "roadmap-eta": params refused: lane: /);
    expect((await run(w.token, 'roadmap-eta', { params: { lane: 'now' } })).status).toBe(200);
  });

  it('refuses a body key it does not know instead of ignoring it', async () => {
    expect((await run(w.token, 'roadmap-eta', { param: {} })).status).toBe(400);
  });
});
