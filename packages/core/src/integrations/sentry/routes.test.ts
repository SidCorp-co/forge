/**
 * ISS-1380 — `POST /:projectId/integrations/sentry/projects`, the picker's listing.
 *
 * Its doors (who may ask, whose credential answers), its two ways of naming a credential, and what
 * a Sentry refusal looks like to the person at the form: a 424 naming the cause, never a 200 with an
 * empty list and never the bare INTERNAL_ERROR an unmapped throw becomes in production.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

let role: 'admin' | 'member' | 'viewer' = 'admin';
vi.mock('../route-helpers.js', () => ({
  assertProjectMember: async () => role,
  assertAdmin: (r: string) => {
    if (r !== 'admin') throw new HTTPException(403, { message: 'forbidden' });
  },
  notFound: () => new HTTPException(404, { message: 'not found' }),
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const BINDING_ID = 'b2222222-2222-4222-8222-222222222222';
const TOKEN = 'sntryu_the_stored_secret_token';

let bound: { binding: Record<string, unknown>; connection: Record<string, unknown> } | null;
let secrets: Record<string, unknown>;
vi.mock('../store.js', () => ({
  findBindingWithConnectionById: async () => bound,
  buildContextFromBinding: () => ({
    config: { host: 'logs.canawan.com' },
    secrets,
  }),
}));

const { registerSentryRoutes } = await import('./routes.js');
const { errorHandler } = await import('../../middleware/error.js');
const { answerWith, calls } = await import('./agent-read.fixture.js');

// biome-ignore lint/suspicious/noExplicitAny: the handler's Variables generic is not this file's subject
const app = new Hono<any>();
registerSentryRoutes(app);
app.use('*', async (c, next) => {
  c.set('userId', 'user-1');
  await next();
});
// biome-ignore lint/suspicious/noExplicitAny: see above
app.onError(errorHandler as any);

const ask = (body: unknown, projectId = PROJECT_ID) =>
  app.request(`/${projectId}/integrations/sentry/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const aProject = { id: '1', slug: 'forge-core', name: 'Forge Core', platform: 'node' };

beforeEach(() => {
  role = 'admin';
  calls.length = 0;
  secrets = { authToken: TOKEN };
  bound = {
    binding: { id: BINDING_ID, projectId: PROJECT_ID, provider: 'sentry' },
    connection: { id: 'conn-1' },
  };
  answerWith({ body: [aProject] });
});
afterEach(() => vi.unstubAllGlobals());

describe('listing through a stored integration', () => {
  it('answers the projects of the named organization, and not one byte of the token', async () => {
    const res = await ask({ integrationId: BINDING_ID, organizationSlug: 'canawan' });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      projects: [
        { organizationSlug: 'canawan', slug: 'forge-core', name: 'Forge Core', platform: 'node' },
      ],
      truncated: false,
    });
    expect(text).not.toContain(TOKEN);
  });

  it("answers 404 for an integration that is not this project's", async () => {
    bound = {
      binding: { id: BINDING_ID, projectId: 'another-project', provider: 'sentry' },
      connection: {},
    };

    expect((await ask({ integrationId: BINDING_ID })).status).toBe(404);
    expect(calls, "a listing through another project's token must not reach Sentry").toEqual([]);
  });

  it('answers 404 for an integration that is not a Sentry one', async () => {
    bound = {
      binding: { id: BINDING_ID, projectId: PROJECT_ID, provider: 'coolify' },
      connection: {},
    };

    expect((await ask({ integrationId: BINDING_ID })).status).toBe(404);
  });

  it('answers 404 for an integration that does not exist', async () => {
    bound = null;

    expect((await ask({ integrationId: BINDING_ID })).status).toBe(404);
  });

  it('answers 409 for a connection that holds no token, without calling Sentry', async () => {
    secrets = {};

    const res = await ask({ integrationId: BINDING_ID });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('MISSING_CREDENTIALS');
    expect(calls).toEqual([]);
  });
});

describe('listing before anything is saved', () => {
  it('uses the host and token in the body', async () => {
    const res = await ask({
      host: 'logs.canawan.com',
      authToken: TOKEN,
      organizationSlug: 'canawan',
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual(['https://logs.canawan.com/api/0/organizations/canawan/projects/']);
  });

  it.each([
    ['a path on the host', { host: 'logs.canawan.com/api', authToken: TOKEN }],
    ['a body naming neither', {}],
    [
      'both an integration and a host',
      { integrationId: BINDING_ID, host: 'h.example', authToken: TOKEN },
    ],
    ['a token too short to be one', { host: 'logs.canawan.com', authToken: 'short' }],
  ])('answers 400 for %s', async (_what, body) => {
    expect((await ask(body)).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('who may ask', () => {
  it.each(['member', 'viewer'] as const)(
    'refuses a project %s with 403 and calls nothing',
    async (r) => {
      role = r;

      expect((await ask({ integrationId: BINDING_ID })).status).toBe(403);
      expect(calls).toEqual([]);
    },
  );
});

describe('when Sentry does not answer a list', () => {
  it("answers 424 SENTRY_REFUSED naming the reason and Sentry's status for a rejected token", async () => {
    answerWith({ status: 401, body: {} });

    const res = await ask({ integrationId: BINDING_ID, organizationSlug: 'canawan' });

    expect(res.status).toBe(424);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details: { reason: string; httpStatus: number };
    };
    expect(body.code).toBe('SENTRY_REFUSED');
    expect(body.details).toEqual({ reason: 'credential_rejected', httpStatus: 401 });
    expect(body.message).toContain('rejected');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('answers 424 for a body that is not a list, and never 200 with none', async () => {
    answerWith({ body: { detail: 'maintenance' } });

    const res = await ask({ integrationId: BINDING_ID, organizationSlug: 'canawan' });

    expect(res.status).toBe(424);
    expect(((await res.json()) as { details: { reason: string } }).details.reason).toBe(
      'unreadable_answer',
    );
  });
});
