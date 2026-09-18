/**
 * The door a runner release is started at, and read back through.
 *
 * What is asserted here is the shape of the refusal rather than the sequence
 * behind it: each kind maps to a status a caller can branch on, and the
 * SENTENCE travels in the body — an operator told `422` and nothing else has
 * been told which step stopped and what is now true on the repository, which is
 * the whole deliverable.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RELEASE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', USER_ID);
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
const authz = vi.hoisted(() => ({
  loadProjectAccess: vi.fn(async () => ({ role: 'admin' }) as unknown),
  assertProjectRole: vi.fn(),
}));
vi.mock('../../lib/authz.js', () => authz);

const service = vi.hoisted(() => ({
  startRunnerRelease: vi.fn(),
  findById: vi.fn(),
  listForProject: vi.fn(),
}));
vi.mock('./runner-release.js', () => ({ startRunnerRelease: service.startRunnerRelease }));
vi.mock('./runner-release-store.js', () => ({
  findById: service.findById,
  listForProject: service.listForProject,
}));

const { runnerReleaseRoutes } = await import('./runner-release-routes.js');
const { errorHandler } = await import('../../middleware/error.js');
const { requestId } = await import('../../middleware/request-id.js');

function app() {
  const built = new Hono<{ Variables: import('../../middleware/request-id.js').RequestIdVars }>();
  built.use('*', requestId());
  built.route('/api/projects', runnerReleaseRoutes);
  built.onError(errorHandler);
  return built;
}

const post = (body: unknown) =>
  app().request(`/api/projects/${PROJECT_ID}/runner-releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const release = {
  id: RELEASE_ID,
  projectId: PROJECT_ID,
  tag: 'runner-v0.13.3',
  tagState: 'present',
};

beforeEach(() => {
  vi.clearAllMocks();
  authz.loadProjectAccess.mockResolvedValue({ role: 'admin' });
});

describe('starting one', () => {
  it('takes a version alone and answers 202 with the release', async () => {
    service.startRunnerRelease.mockResolvedValue({ started: true, release });
    const res = await post({ version: '0.13.3' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ release });
    expect(service.startRunnerRelease).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      version: '0.13.3',
      requestedById: USER_ID,
    });
  });

  it('passes a commit through when one is named', async () => {
    service.startRunnerRelease.mockResolvedValue({ started: true, release });
    await post({ version: '0.13.3', commit: 'abc1234' });
    expect(service.startRunnerRelease).toHaveBeenCalledWith(
      expect.objectContaining({ commit: 'abc1234' }),
    );
  });

  // cm:guard `.strict()` on the body. A caller who sends `tag` has misread the interface — the tag is Forge's to build — and absorbing the key would be a second live path nobody documented.
  it('refuses a body carrying a key this interface does not have', async () => {
    const res = await post({ version: '0.13.3', tag: 'runner-v0.13.3' });
    expect(res.status).toBe(400);
    expect(service.startRunnerRelease).not.toHaveBeenCalled();
  });

  it('refuses a body with no version at all', async () => {
    expect((await post({})).status).toBe(400);
    expect(service.startRunnerRelease).not.toHaveBeenCalled();
  });
});

describe('the refusals, and the sentence each one carries', () => {
  const cases = [
    ['no_repository', 409],
    ['bad_version', 400],
    ['already_attempted', 409],
    ['stopped', 422],
  ] as const;

  for (const [kind, status] of cases) {
    it(`answers ${status} for ${kind}, carrying the sentence and the release`, async () => {
      service.startRunnerRelease.mockResolvedValue({
        started: false,
        kind,
        message: `the sentence for ${kind}`,
        release,
      });
      const res = await post({ version: '0.13.3' });
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      expect(res.status).toBe(status);
      expect(JSON.stringify(body)).toContain(`the sentence for ${kind}`);
      expect(JSON.stringify(body)).toContain(`RUNNER_RELEASE_${kind.toUpperCase()}`);
    });
  }
});

describe('reading them back', () => {
  it('lists this project`s releases', async () => {
    service.listForProject.mockResolvedValue([release]);
    const res = await app().request(`/api/projects/${PROJECT_ID}/runner-releases`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ releases: [release] });
  });

  it('serves one by id', async () => {
    service.findById.mockResolvedValue(release);
    const res = await app().request(`/api/projects/${PROJECT_ID}/runner-releases/${RELEASE_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ release });
  });

  // cm:guard the project is checked on the ROW. Taking it from the path would serve one project's release to whoever can read another, and a 404 is the same answer as for an id that never existed.
  it('refuses an id that belongs to another project as not found', async () => {
    service.findById.mockResolvedValue({
      ...release,
      projectId: '44444444-4444-4444-8444-444444444444',
    });
    const res = await app().request(`/api/projects/${PROJECT_ID}/runner-releases/${RELEASE_ID}`);
    expect(res.status).toBe(404);
  });

  it('refuses a project the caller cannot reach', async () => {
    authz.loadProjectAccess.mockResolvedValue(null);
    expect((await app().request(`/api/projects/${PROJECT_ID}/runner-releases`)).status).toBe(404);
    expect((await post({ version: '0.13.3' })).status).toBe(404);
    expect(service.startRunnerRelease).not.toHaveBeenCalled();
  });

  it('asks for an admin before it starts one', async () => {
    service.startRunnerRelease.mockResolvedValue({ started: true, release });
    await post({ version: '0.13.3' });
    expect(authz.assertProjectRole).toHaveBeenCalledWith({ role: 'admin' }, 'admin');
  });
});
