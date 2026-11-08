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
    expect(refusalsOf(unknown)[0]?.detail).toContain('`loginRoute`');
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
    logger.level = level;
    expect(answers.map((a) => a.status)).toEqual([200, 422, 422, 422]);
    expect(said.length, 'no line was written to watch').toBeGreaterThan(0);
    for (const value of [USER, PASS, LABEL, 'an-api-key-not-json-1140']) {
      for (const a of answers) expect(JSON.stringify(a.body)).not.toContain(value);
      for (const line of said) expect(line).not.toContain(value);
    }
    for (const a of answers) expect(JSON.stringify(a.body)).not.toMatch(/length|chars/i);
  });
});
