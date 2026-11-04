/**
 * @direct-test-of packages/core/src/integrations/gitlab/check-jobs.ts
 * @direct-test-of packages/core/src/integrations/github/agent-ops.ts
 */
// FB-469 (ISS-931): sid-desk pipeline 3015177964, 2026-11-02. A GitLab check is a pipeline and its
// id a pipeline id, the log route takes a job id, and nothing listed one: the pipeline id sent to
// the log answered HOST_UNAVAILABLE 404. Driven here through the routes, over the real GitLab host
// and a fake GitLab answering by path; GitHub over its real agent reads and a fake App client.
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubAgentClient } from '../integrations/github/agent-client.js';
import { errorHandler } from '../middleware/error.js';

const { declarationData } = vi.hoisted(() => ({
  declarationData: async () => {
    const d = await import('../middleware/declared-permission.js');
    const pass = () => async (_c: unknown, next: () => Promise<void>) => next();
    return {
      onArg: d.onArg,
      onResolved: d.onResolved,
      permissionless: d.permissionless,
      byRule: d.byRule,
      requiresByRule: pass,
      requiresInstanceAdmin: pass,
      requiresSelf: pass,
      requiresPublic: pass,
    };
  },
}));

const state = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('../permissions/index.js', async () => {
  const data = await declarationData();
  const pass = () => async (_c: unknown, next: () => Promise<void>) => next();
  return {
    ...data,
    actorFor: (id: string) => ({ id }),
    projectResource: (id: string) => ({ id }),
    requireCan: async () => {},
    requiresOnParam: pass,
    requiresOnResolved: pass,
    requiresNoPermission: pass,
    requireDeclared: () => {},
    requireDeclaredOn: async () => {},
  };
});

vi.mock('../integrations/source-host/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../integrations/source-host/index.js')>();
  return { ...real, resolveSourceHost: async () => state.host };
});

const { registerSourceRoutes } = await import('./source-routes.js');
const { gitlabSourceHost } = await import('../integrations/gitlab/source-host.js');
const { clearGitLabHolds } = await import('../integrations/gitlab/cooldown.js');
const { readCheckRunJobs, readCheckRunLog } = await import('../integrations/github/agent-ops.js');

const P = '00000000-0000-4000-8000-000000000001';
const PIPELINE = 3015177964;
const FAILED_JOB = 11906411;
const PASSED_JOB = 11906410;
const API = 'https://gitlab.example/api/v4/projects/sidcorp%2Fsid-desk';

function app() {
  // biome-ignore lint/suspicious/noExplicitAny: the routes' AuthVars carry more than a test sets
  const a = new Hono<any>();
  a.use('*', async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });
  registerSourceRoutes(a);
  a.onError(errorHandler as never);
  return a;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const missing = () => new Response(JSON.stringify({ message: '404 Not found' }), { status: 404 });

const jobs = [
  {
    id: PASSED_JOB,
    name: 'lint',
    stage: 'test',
    status: 'success',
    failure_reason: null,
    web_url: `https://gitlab.example/sidcorp/sid-desk/-/jobs/${PASSED_JOB}`,
  },
  {
    id: FAILED_JOB,
    name: 'build',
    stage: 'build',
    status: 'failed',
    failure_reason: 'script_failure',
    web_url: `https://gitlab.example/sidcorp/sid-desk/-/jobs/${FAILED_JOB}`,
  },
];

/** GitLab as sid-desk's project answers: one failed pipeline, its two jobs, the failed one's trace. */
function gitlab(url: string): Response {
  const path = url.slice(API.length).replace(/[?&]per_page=100&page=1$/, '');
  if (path === `/pipelines/${PIPELINE}/jobs`) return json(jobs);
  if (path === `/pipelines/${PIPELINE}`) return json({ id: PIPELINE, status: 'failed' });
  const job = jobs.find((j) => path === `/jobs/${j.id}`);
  if (job) return json(job);
  if (path === `/jobs/${FAILED_JOB}/trace`) {
    return new Response('$ pnpm build\nerror TS2304: Cannot find name x\nERROR: Job failed\n');
  }
  return missing();
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  clearGitLabHolds();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => gitlab(String(input)));
  vi.stubGlobal('fetch', fetchMock);
  state.host = gitlabSourceHost.build({
    bindingId: 'b1',
    config: { projectPath: 'sidcorp/sid-desk', baseUrl: 'https://gitlab.example' },
    secrets: { token: 'glpat-test-not-a-token' },
  });
});
afterEach(() => vi.unstubAllGlobals());

const get = (path: string) => app().request(`/${P}/integrations/source/${path}`);
const called = () => fetchMock.mock.calls.map(([u]) => String(u).slice(API.length));

describe('a GitLab check lists its pipeline jobs, and the log takes a job id', () => {
  it("lists a failed pipeline's jobs with their job ids, status and failure reason", async () => {
    const res = await get(`checks/${PIPELINE}/jobs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      checkId: PIPELINE,
      truncated: false,
      jobs: [
        {
          jobId: PASSED_JOB,
          name: 'lint',
          stage: 'test',
          status: 'completed',
          conclusion: 'success',
          failureReason: null,
          detailsUrl: `https://gitlab.example/sidcorp/sid-desk/-/jobs/${PASSED_JOB}`,
        },
        {
          jobId: FAILED_JOB,
          name: 'build',
          stage: 'build',
          status: 'completed',
          conclusion: 'failure',
          failureReason: 'script_failure',
          detailsUrl: `https://gitlab.example/sidcorp/sid-desk/-/jobs/${FAILED_JOB}`,
        },
      ],
    });
    expect(called()).toEqual([`/pipelines/${PIPELINE}/jobs?per_page=100&page=1`]);
    // read with the binding's token, and only that
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['PRIVATE-TOKEN']).toBe('glpat-test-not-a-token');
  });

  it("reads the failed job's trace by the job id the list named, in the log's own shape", async () => {
    const res = await get(`checks/${FAILED_JOB}/log?lines=2`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      checkRunId: FAILED_JOB,
      name: 'build',
      app: 'gitlab-ci',
      status: 'completed',
      conclusion: 'failure',
      detailsUrl: `https://gitlab.example/sidcorp/sid-desk/-/jobs/${FAILED_JOB}`,
      summary: 'script_failure',
      log: 'ERROR: Job failed\n',
      truncated: true,
      refusal: null,
    });
  });

  it('refuses a pipeline id sent to the log by name, pointing at the job list', async () => {
    const res = await get(`checks/${PIPELINE}/log`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CHECK_ID_IS_A_PIPELINE');
    expect(JSON.stringify(body)).toContain(`checks/${PIPELINE}/jobs`);
    expect(called()).toEqual([`/jobs/${PIPELINE}`, `/pipelines/${PIPELINE}`]);
  });

  it('refuses a job id sent to the job list by name, pointing at its log', async () => {
    const res = await get(`checks/${FAILED_JOB}/jobs`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CHECK_ID_IS_A_JOB');
    expect(JSON.stringify(body)).toContain(`checks/${FAILED_JOB}/log`);
  });

  it('answers an id that is neither as the host failing, the 404 it said', async () => {
    const res = await get('checks/42/log');
    expect(res.status).not.toBe(200);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('HOST_UNAVAILABLE');
    expect(called()).toEqual(['/jobs/42', '/pipelines/42']);
  });

  it('does not read the pipeline when the job read failed on anything but a 404', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 403 }));
    const res = await get(`checks/${PIPELINE}/log`);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('HOST_UNAVAILABLE');
    expect(called()).toEqual([`/jobs/${PIPELINE}`]);
  });

  it('says the list may stand longer where it filled every page the read takes', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `j${i}`,
      status: 'success',
    }));
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(page), { status: 200, headers: { 'x-next-page': '2' } }),
    );
    const res = await get(`checks/${PIPELINE}/jobs`);
    const body = (await res.json()) as { jobs: unknown[]; truncated: boolean };
    expect(body.jobs).toHaveLength(1000);
    expect(body.truncated).toBe(true);
  });
});

describe('GitHub: a check run already is its one job, and its log reads as before', () => {
  const run = {
    id: 77,
    name: 'core-unit',
    status: 'completed',
    conclusion: 'failure',
    details_url: 'https://github.com/acme/shop/actions/runs/5/job/88',
    html_url: 'https://github.com/acme/shop/runs/77',
    app: { slug: 'github-actions' },
    output: { title: '2 tests failed', summary: 'see the log' },
  };
  const reads: string[] = [];
  const agent = {
    bindingId: 'b1',
    owner: 'acme',
    repo: 'shop',
    fullName: 'acme/shop',
    json: async <T>({ path }: { path: string }): Promise<T> => {
      reads.push(path);
      return run as T;
    },
    text: async ({ path }: { path: string }) => {
      reads.push(path);
      return { body: 'a\nb\nFAIL x\n', bytes: 11, truncated: false };
    },
    scrub: async (t: string) => t,
  } as unknown as GitHubAgentClient;

  beforeEach(() => {
    reads.length = 0;
    state.host = {
      provider: 'github',
      bindingId: 'b1',
      fullName: 'acme/shop',
      words: { changeRequest: 'pull request', sigil: '#' },
      checkJobs: (args: { checkId: number }) => readCheckRunJobs(agent, args),
      checkLog: (args: { checkRunId: number; lines?: number }) => readCheckRunLog(agent, args),
    };
  });

  it('lists the check run itself as the one job, by the id its log takes', async () => {
    const res = await get('checks/77/jobs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      checkId: 77,
      truncated: false,
      jobs: [
        {
          jobId: 77,
          name: 'core-unit',
          stage: null,
          status: 'completed',
          conclusion: 'failure',
          failureReason: '2 tests failed',
          detailsUrl: 'https://github.com/acme/shop/actions/runs/5/job/88',
        },
      ],
    });
    expect(reads).toEqual(['/repos/acme/shop/check-runs/77']);
  });

  it("reads a check run's log through its Actions job, unchanged", async () => {
    const res = await get('checks/77/log?lines=2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      checkRunId: 77,
      name: 'core-unit',
      app: 'github-actions',
      status: 'completed',
      conclusion: 'failure',
      detailsUrl: 'https://github.com/acme/shop/actions/runs/5/job/88',
      summary: 'see the log',
      log: 'FAIL x\n',
      truncated: true,
      refusal: null,
    });
    expect(reads).toEqual([
      '/repos/acme/shop/check-runs/77',
      '/repos/acme/shop/actions/jobs/88/logs',
    ]);
  });
});
