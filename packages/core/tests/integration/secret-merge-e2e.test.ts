/**
 * An actor secret gains `loginRoute` without anyone reading or retyping its value (ISS-1140).
 * epod's judge secrets were stored as `{ username, password, label }`; judge-login refused them for
 * naming no sign-in route, and the only write was a PUT of the whole value, which the master may
 * not read. `PATCH /api/projects/:id/secrets/:scope/:name { "set": { "loginRoute": … } }` merges
 * the key in core, keeps every other key as it was, runs the sign-in check a PUT runs, and answers
 * what a PUT answers: never the value, its account or its length.
 * Against real Postgres, with the environment's sign-in stubbed — never forge-dev.
 *
 * @direct-test-of packages/core/src/project-config/secret-write.ts
 * @direct-test-of packages/core/src/project-config/secret-routes.ts
 * @direct-test-of packages/core/src/project-config/actor-sign-in.ts
 * @direct-test-of packages/core/src/integrations/deploy/sign-in-probe.ts
 *
 * ISS-1141: epod's admin signs in with a GraphQL mutation, so the merge also takes `loginBody` and
 * `tokenPath`, and the probe sends that body and reads the token there.
 *
 * ISS-1145: epod's admin restores a browser session from five localStorage keys, so the merge also
 * takes `storage` (each key a JSON pointer into the sign-in's answer) and `storageKey`, and the
 * probe confirms each pointer resolves.
 */

import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { logger } from '../../src/lib/logger.js';
import { readProjectSecrets } from '../../src/project-config/secret-read.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const ORIGIN = 'https://qa.epod.example.test';
const SIGN_IN = `${ORIGIN}/api/auth/login`;
const USER = 'judge-1140@epod.test';
const PASS = 'Corr3ct-H0rse-Battery-1140';
const LABEL = 'epod judge (admin)';
// the shape epod's judge secrets were stored in: an account and a password, no sign-in route
const STORED = { username: USER, password: PASS, label: LABEL };
const GRAPHQL = `${ORIGIN}/graphql`;
const MUTATION =
  'mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { access_token } }';
// the merge epod's master sends for each of its secrets (ISS-1141)
const GRAPHQL_SET = {
  loginRoute: GRAPHQL,
  loginBody: { query: MUTATION, variables: { email: '$account', password: '$password' } },
  tokenPath: '/data/login/access_token',
};

// epod's admin's own login (ISS-1145): the token, its expiry, the user and the organization
const EPOD_MUTATION =
  'mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { access_token expires_at user { id email name role } organization { id code name email phone status } } }';
const EPOD_ANSWER = {
  access_token: 'gql-session-1145',
  token_type: 'Bearer',
  expires_at: '2026-11-09T13:21:00Z',
  expires_in: 86400,
  user: { id: 'user-1145-owner', email: 'owner@epod.test', name: 'Owner', role: 'admin' },
  organization: { id: 'org-1145-test-store', code: 'TS', name: 'Test Store', status: 'active' },
};
// the merge epod's master sends for each of its secrets once ISS-1145 is live
const EPOD_STORAGE_SET = {
  loginBody: { query: EPOD_MUTATION, variables: { email: '$account', password: '$password' } },
  storage: {
    auth_token: '/data/login/access_token',
    auth_token_expires_at: '/data/login/expires_at',
    user: '/data/login/user',
    organization: '/data/login/organization',
    organization_id: '/data/login/organization/id',
  },
};

const w = { projectId: '', token: '' };
const spy = vi.spyOn as unknown as (
  target: object,
  method: string,
) => { mockImplementation(f: (...args: unknown[]) => unknown): void };
let seen: { url: string; body: Record<string, unknown> }[] = [];

const put = (scope: string, name: string, value: string) =>
  api(w.token, 'PUT', `/api/projects/${w.projectId}/secrets/${scope}/${name}`, { value });
const patch = (scope: string, name: string, body: unknown) =>
  api(w.token, 'PATCH', `/api/projects/${w.projectId}/secrets/${scope}/${name}`, body);

async function ok(r: Promise<ApiResponse>): Promise<Record<string, unknown>> {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** The value as the store holds it, decrypted here and never through an answer. */
async function stored(ref: string): Promise<unknown> {
  const read = await readProjectSecrets(w.projectId, [ref]);
  if (!read.ok) throw new Error(`${ref}: ${read.code}`);
  return JSON.parse(read.values.get(ref) as string);
}

function refusalsOf(res: ApiResponse) {
  return (res.body.error as { refusals: { code: string; path: string; detail: string }[] })
    .refusals;
}

beforeEach(async () => {
  await truncateAll();
  seen = [];
  const owner = await createTestUser({ verified: true });
  w.projectId = (await createTestProject(owner.id)).id;
  await addProjectMember(w.projectId, owner.id, 'admin');
  w.token = await userToken(owner.id);
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(ORIGIN)) return real(input, init);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ url, body });
    if (url === SIGN_IN && body.username === USER && body.password === PASS) {
      return Response.json({ token: 'session-token-1140' });
    }
    if (url === GRAPHQL) {
      // a GraphQL server: 200 with `errors` for a wrong account, its token under data.login
      const vars = (body.variables ?? {}) as Record<string, unknown>;
      const epod = body.query === EPOD_MUTATION;
      if (body.query !== MUTATION && !epod) {
        return Response.json({ errors: [{}] }, { status: 422 });
      }
      if (vars.email !== USER || vars.password !== PASS) {
        return Response.json({
          errors: [{ message: `no user ${String(vars.email)}` }],
          data: null,
        });
      }
      if (epod) return Response.json({ data: { login: EPOD_ANSWER } });
      return Response.json({ data: { login: { access_token: 'gql-session-1141' } } });
    }
    return Response.json({ error: { code: 'INVALID_CREDENTIALS' } }, { status: 401 });
  });
  await ok(put('dev', 'judge', JSON.stringify(STORED)));
  await ok(put('dev', 'plain', 'an-api-key-not-json-1140'));
  await ok(
    api(w.token, 'PUT', `/api/projects/${w.projectId}/testing-profiles/dev`, {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
        version: 1,
        id: 'dev',
        actors: { admin: { role: 'project-member', credential: 'secret://dev/judge' } },
        services: {},
        limits: [],
      },
    }),
  );
  await seedProjectDocument(w.projectId, owner.id, {
    environments: {
      qa: {
        tier: 'staging',
        deploysFrom: 'main',
        deployment: { mode: 'external' },
        testing: 'dev',
        url: ORIGIN,
      },
    },
  });
});

afterEach(() => vi.restoreAllMocks());

describe('a secret gains loginRoute without its value being read or retyped (ISS-1140)', () => {
  it('the route-less secret names the PATCH door, and the merge keeps every other key and signs in', async () => {
    const before = await ok(put('dev', 'judge', JSON.stringify(STORED)));
    expect(JSON.stringify(before.signIn)).toContain(
      `PATCH /api/projects/${w.projectId}/secrets/dev/judge {\\"set\\":{\\"loginRoute\\":`,
    );
    expect(seen).toEqual([]);

    const body = await ok(patch('dev', 'judge', { set: { loginRoute: '/api/auth/login' } }));
    expect(Object.keys(body).sort()).toEqual(['name', 'ref', 'scope', 'signIn', 'updatedAt']);
    expect(body).toMatchObject({ ref: 'secret://dev/judge', scope: 'dev', name: 'judge' });
    // the probe ran after the merge, with the merged value, and reported as a PUT reports it
    expect(body.signIn).toEqual([
      expect.objectContaining({ profile: 'dev', actor: 'admin', answer: 'signs-in', at: SIGN_IN }),
    ]);
    expect(seen).toEqual([{ url: SIGN_IN, body: { username: USER, password: PASS } }]);
    expect(await stored('secret://dev/judge')).toEqual({
      ...STORED,
      loginRoute: '/api/auth/login',
    });

    // a second merge replaces the route alone
    await ok(patch('dev', 'judge', { set: { loginRoute: `POST ${SIGN_IN}` } }));
    expect(await stored('secret://dev/judge')).toEqual({
      ...STORED,
      loginRoute: `POST ${SIGN_IN}`,
    });
  });

  it('a GraphQL sign-in is merged as loginRoute, loginBody and tokenPath, probed, and kept (ISS-1141)', async () => {
    // today's shape at the GraphQL endpoint is what epod's master was refused: answered 422
    const before = await patch('dev', 'judge', { set: { loginRoute: GRAPHQL } });
    expect(before.status, JSON.stringify(before.body)).toBe(422);
    expect(refusalsOf(before)[0]?.detail).toContain('answered 422');

    const body = await ok(patch('dev', 'judge', { set: GRAPHQL_SET }));
    expect(body.signIn).toEqual([
      expect.objectContaining({ profile: 'dev', actor: 'admin', answer: 'signs-in', at: GRAPHQL }),
    ]);
    expect(seen.at(-1)).toEqual({
      url: GRAPHQL,
      body: { query: MUTATION, variables: { email: USER, password: PASS } },
    });
    expect(await stored('secret://dev/judge')).toEqual({ ...STORED, ...GRAPHQL_SET });
    for (const v of [USER, PASS]) expect(JSON.stringify(body)).not.toContain(v);

    // a wrong password answers 200 with `errors` that echo the account: refused, the text unsaid
    await ok(put('dev', 'judge', JSON.stringify({ ...STORED, password: 'wrong-1141' })));
    const wrong = await patch('dev', 'judge', { set: GRAPHQL_SET });
    expect(wrong.status).toBe(422);
    expect(refusalsOf(wrong)[0]?.detail).toContain('with a GraphQL `errors` array');
    expect(JSON.stringify(wrong.body)).not.toContain(USER);
  });

  it('a merged value the environment refuses is refused by name, and the value held before is kept', async () => {
    const res = await patch('dev', 'judge', { set: { loginRoute: `${ORIGIN}/api/auth/local` } });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(refusalsOf(res)).toEqual([expect.objectContaining({ code: 'SECRET_DOES_NOT_SIGN_IN' })]);
    expect(await stored('secret://dev/judge')).toEqual(STORED);
  });

  it('another key, an empty set, a bad route, a non-JSON value, a missing secret and the variable scope are refused by name', async () => {
    const cases: [unknown, string, string, number, string][] = [
      [{ set: { password: 'x' } }, 'dev', 'judge', 422, 'SECRET_MERGE_KEY_UNKNOWN'],
      [{ set: {} }, 'dev', 'judge', 422, 'SECRET_MERGE_EMPTY'],
      [
        { set: { loginRoute: 'GET /api/auth/login' } },
        'dev',
        'judge',
        422,
        'SECRET_LOGIN_ROUTE_INVALID',
      ],
      [
        { set: { loginRoute: 'http://qa.epod.example.test/x' } },
        'dev',
        'judge',
        422,
        'SECRET_LOGIN_ROUTE_INVALID',
      ],
      [{ set: { loginRoute: 7 } }, 'dev', 'judge', 422, 'SECRET_LOGIN_ROUTE_INVALID'],
      [
        {
          set: {
            loginBody: { query: MUTATION, variables: { email: '$email', password: '$password' } },
          },
        },
        'dev',
        'judge',
        422,
        'SECRET_LOGIN_BODY_INVALID',
      ],
      [
        { set: { loginBody: { email: '$account' } } },
        'dev',
        'judge',
        422,
        'SECRET_LOGIN_BODY_INVALID',
      ],
      [{ set: { loginBody: 'x' } }, 'dev', 'judge', 422, 'SECRET_LOGIN_BODY_INVALID'],
      [{ set: { tokenPath: 'data.login' } }, 'dev', 'judge', 422, 'SECRET_TOKEN_PATH_INVALID'],
      [{ set: { storage: 'auth_token' } }, 'dev', 'judge', 422, 'SECRET_STORAGE_INVALID'],
      [{ set: { storage: {} } }, 'dev', 'judge', 422, 'SECRET_STORAGE_INVALID'],
      [
        { set: { storage: { user: 'data.login.user' } } },
        'dev',
        'judge',
        422,
        'SECRET_STORAGE_INVALID',
      ],
      [{ set: { storageKey: 7 } }, 'dev', 'judge', 422, 'SECRET_STORAGE_INVALID'],
      [{ set: { storageKey: '' } }, 'dev', 'judge', 422, 'SECRET_STORAGE_INVALID'],
      [{ set: { loginRoute: '/x' } }, 'dev', 'plain', 422, 'SECRET_NOT_JSON_OBJECT'],
      [{ set: { loginRoute: '/x' } }, 'dev', 'absent', 404, 'SECRET_NOT_FOUND'],
      [{ set: { loginRoute: '/x' } }, 'var', 'judge', 422, 'SECRET_SCOPE_RESERVED'],
      [{ value: 'x' }, 'dev', 'judge', 400, 'SECRET_MERGE_SHAPE'],
    ];
    for (const [body, scope, name, status, code] of cases) {
      const res = await patch(scope, name, body);
      const said = JSON.stringify(res.body);
      expect(res.status, said).toBe(status);
      expect(said, JSON.stringify(body)).toContain(code);
    }
    const unknown = await patch('dev', 'judge', { set: { password: 'x', label: 'y' } });
    expect(refusalsOf(unknown).map((r) => r.path)).toEqual(['/set/label', '/set/password']);
    expect(refusalsOf(unknown)[0]?.detail).toContain(
      '`loginRoute`, `loginBody`, `tokenPath`, `storageKey`, `storage`',
    );
    expect(await stored('secret://dev/judge')).toEqual(STORED);
    expect(seen).toEqual([]);
  });

  it('no answer or log line holds the value or its account', async () => {
    const level = logger.level;
    logger.level = 'trace';
    const said: string[] = [];
    const keep = (chunk: unknown) => {
      said.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
    };
    for (const [target, method] of [
      [process.stdout, 'write'],
      [process.stderr, 'write'],
      [fs, 'writeSync'],
      [fs, 'write'],
    ] as const) {
      const original = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
      spy(target, method).mockImplementation((...args) => {
        keep(typeof args[0] === 'number' ? args[1] : args[0]);
        return original?.apply(target, args);
      });
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spy(console, method).mockImplementation((...args) => keep(args.join(' ')));
    }
    const answers: ApiResponse[] = [];
    answers.push(await patch('dev', 'judge', { set: { loginRoute: '/api/auth/login' } }));
    answers.push(await patch('dev', 'judge', { set: { loginRoute: `${ORIGIN}/api/auth/local` } }));
    answers.push(await patch('dev', 'judge', { set: { username: 'x' } }));
    answers.push(await patch('dev', 'plain', { set: { loginRoute: '/x' } }));
    answers.push(await patch('dev', 'judge', { set: GRAPHQL_SET }));
    answers.push(await patch('dev', 'judge', { set: { loginBody: { u: '$account' } } }));
    answers.push(await patch('dev', 'judge', { set: EPOD_STORAGE_SET }));
    answers.push(await patch('dev', 'judge', { set: { storage: { user: '/data/login/nobody' } } }));
    logger.level = level;
    expect(answers.map((a) => a.status)).toEqual([200, 422, 422, 422, 200, 422, 200, 422]);
    expect(said.length, 'no line was written to watch').toBeGreaterThan(0);
    const epodValues = [
      EPOD_ANSWER.access_token,
      EPOD_ANSWER.expires_at,
      EPOD_ANSWER.user.id,
      EPOD_ANSWER.user.email,
      EPOD_ANSWER.organization.id,
    ];
    for (const value of [USER, PASS, LABEL, 'an-api-key-not-json-1140', ...epodValues]) {
      for (const a of answers) expect(JSON.stringify(a.body)).not.toContain(value);
      for (const line of said) expect(line).not.toContain(value);
    }
    for (const a of answers) expect(JSON.stringify(a.body)).not.toMatch(/length|chars/i);
  });
});

describe('a secret describes the browser session it hands a judge (ISS-1145)', () => {
  it('a secret describes the browser session as storage, each pointer probed, and kept (ISS-1145)', async () => {
    await ok(patch('dev', 'judge', { set: GRAPHQL_SET }));
    const res = await patch('dev', 'judge', { set: EPOD_STORAGE_SET });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.signIn).toEqual([
      expect.objectContaining({ profile: 'dev', actor: 'admin', answer: 'signs-in', at: GRAPHQL }),
    ]);
    expect(await stored('secret://dev/judge')).toEqual({
      ...STORED,
      ...GRAPHQL_SET,
      ...EPOD_STORAGE_SET,
    });

    // a pointer the answer does not hold is refused naming the key and the pointer, never a value
    const lacking = await patch('dev', 'judge', {
      set: { storage: { ...EPOD_STORAGE_SET.storage, organization_id: '/data/login/org/id' } },
    });
    expect(lacking.status, JSON.stringify(lacking.body)).toBe(422);
    expect(refusalsOf(lacking)).toEqual([
      expect.objectContaining({ code: 'SECRET_DOES_NOT_SIGN_IN' }),
    ]);
    expect(refusalsOf(lacking)[0]?.detail).toContain(
      'with nothing at `/data/login/org/id` for the storage key `organization_id`',
    );
    for (const v of [USER, PASS, EPOD_ANSWER.access_token, EPOD_ANSWER.organization.id]) {
      expect(JSON.stringify(lacking.body)).not.toContain(v);
    }
    expect((await stored('secret://dev/judge')) as object).toMatchObject(EPOD_STORAGE_SET);

    // a selection of the token alone answers no user: the same storage is refused at the probe
    const tokenOnly = await patch('dev', 'judge', { set: { loginBody: GRAPHQL_SET.loginBody } });
    expect(refusalsOf(tokenOnly)[0]?.detail).toContain(
      'with nothing at `/data/login/expires_at` for the storage key `auth_token_expires_at`',
    );
  });

  it('storageKey stays shorthand for the token under one key, and both naming one key is refused (ISS-1145)', async () => {
    await ok(put('dev', 'judge', JSON.stringify({ ...STORED, ...GRAPHQL_SET })));
    const body = await ok(patch('dev', 'judge', { set: { storageKey: 'auth_token' } }));
    expect(body.signIn).toEqual([expect.objectContaining({ answer: 'signs-in' })]);
    const both = await patch('dev', 'judge', {
      set: { storage: { auth_token: '/data/login/access_token' } },
    });
    expect(both.status, JSON.stringify(both.body)).toBe(422);
    expect(refusalsOf(both)).toEqual([
      expect.objectContaining({
        code: 'SECRET_STORAGE_INVALID',
        detail: expect.stringContaining('`storageKey` and `storage` both name `auth_token`'),
      }),
    ]);
    expect(await stored('secret://dev/judge')).toEqual({
      ...STORED,
      ...GRAPHQL_SET,
      storageKey: 'auth_token',
    });
  });
});
