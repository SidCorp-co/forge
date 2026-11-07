/**
 * A testing profile's actor secret is tried when it is written (ISS-937). forge's
 * `secret://dev/qa` was written 2026-09-30, the QA member's password changed after, and nothing
 * said so until judge K162's `POST /api/auth/local` answered 401 INVALID_CREDENTIALS five weeks
 * later. Now the write signs in once at the environment naming the profile, through the shape
 * `forge-runner judge-login` reads: a value the environment refuses is refused by name and the
 * value held before is kept; a write made while the environment cannot answer is kept and flags
 * the actor unusable on its profile until a write that signs in clears it; a shape the probe
 * cannot use is stored and named, never sent. No answer, log line or stored row holds the value.
 * Against real Postgres, with the environment's sign-in stubbed — never forge-dev.
 *
 * @direct-test-of packages/core/src/project-config/secret-write.ts
 * @direct-test-of packages/core/src/project-config/actor-sign-in.ts
 * @direct-test-of packages/core/src/integrations/deploy/sign-in-probe.ts
 * @direct-test-of packages/core/src/project-config/secret-routes.ts
 * @direct-test-of packages/core/src/project-config/routes.ts
 */

import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { logger } from '../../src/lib/logger.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const ORIGIN = 'https://qa.forge.example.test';
const SIGN_IN = `${ORIGIN}/api/auth/local`;
// a Strapi sign-in, as SidDesk's reads it: the account under `identifier` (ISS-1083)
const STRAPI_SIGN_IN = `${ORIGIN}/api/auth/login`;
const EMAIL = 'qa-member-937@forge-dev.test';
const RIGHT = 'Corr3ct-H0rse-Battery-937';
const WRONG = 'Tr0ub4dor-drifted-937';
const secret = (password: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'forge-member',
    loginRoute: '/api/auth/local',
    email: EMAIL,
    password,
    ...extra,
  });

const w = { projectId: '', token: '' };
// a spy on a writer whose overloads vitest cannot name: every call passes through, its first text kept
const spy = vi.spyOn as unknown as (
  target: object,
  method: string,
) => { mockImplementation(f: (...args: unknown[]) => unknown): void };
let environment: 'up' | 'down' | 'busy' = 'up';
let seen: { url: string; body: Record<string, unknown> }[] = [];

const put = (scope: string, name: string, value: string) =>
  api(w.token, 'PUT', `/api/projects/${w.projectId}/secrets/${scope}/${name}`, { value });

async function ok(r: Promise<ApiResponse>): Promise<Record<string, unknown>> {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function profile(id = 'dev') {
  const body = await ok(api(w.token, 'GET', `/api/projects/${w.projectId}/testing-profiles/${id}`));
  return body.signIn as {
    actors: Record<string, { usable: boolean | null; checkedAt: string | null; says: string }>;
    services: Record<string, { usable: null; says: string }>;
  };
}

function writeProfile(id: string, actors: Record<string, string>, services = {}) {
  return ok(
    api(w.token, 'PUT', `/api/projects/${w.projectId}/testing-profiles/${id}`, {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
        version: 1,
        id,
        actors: Object.fromEntries(
          Object.entries(actors).map(([a, ref]) => [
            a,
            { role: 'project-member', credential: ref },
          ]),
        ),
        services,
        limits: [],
      },
    }),
  );
}

const storedValue = async () =>
  (
    await rows<{ v: string }>(
      sql`SELECT encode(value_enc, 'hex') AS v FROM project_secrets WHERE scope = 'dev' AND name = 'qa'`,
    )
  )[0]?.v;

beforeEach(async () => {
  await truncateAll();
  environment = 'up';
  seen = [];
  const owner = await createTestUser({ verified: true });
  w.projectId = (await createTestProject(owner.id)).id;
  await addProjectMember(w.projectId, owner.id, 'admin');
  w.token = await userToken(owner.id);
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(ORIGIN)) return real(input, init);
    seen.push({ url, body: JSON.parse(String(init?.body)) });
    if (environment === 'down') {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }
    if (environment === 'busy') return Response.json({}, { status: 503 });
    const body = seen[seen.length - 1]?.body ?? {};
    if (url === SIGN_IN && body.email === EMAIL && body.password === RIGHT) {
      return Response.json({ token: 'session-token-937' });
    }
    if (url === STRAPI_SIGN_IN) {
      if (body.identifier === EMAIL && body.password === RIGHT) {
        return Response.json({ token: 'session-token-1083' });
      }
      return Response.json(
        { error: { message: 'identifier and password are required' } },
        { status: 400 },
      );
    }
    return Response.json(
      { error: { code: 'INVALID_CREDENTIALS', message: 'invalid credentials' } },
      { status: 401 },
    );
  });
  // a profile names only a stored secret, so each is written once before the profile exists
  await ok(put('dev', 'qa', 'written-before-the-profile-937'));
  await ok(put('dev', 'store-key', 'store-service-key-937-planted'));
  await ok(put('dev', 'lone', 'written-before-the-profile-937'));
  await writeProfile(
    'dev',
    { member: 'secret://dev/qa' },
    { store: { access: 'readonly', credential: 'secret://dev/store-key' } },
  );
  await writeProfile('lone', { admin: 'secret://dev/lone' });
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

describe('an actor secret is tried at its environment when it is written (ISS-937)', () => {
  it('a value that signs in is kept, and the profile reads the actor usable', async () => {
    const before = await profile();
    expect(before.actors.member).toMatchObject({ usable: null });
    expect(before.actors.member?.says).toContain('did not name it');

    const body = await ok(put('dev', 'qa', secret(RIGHT)));
    expect(body.signIn).toEqual([
      expect.objectContaining({
        profile: 'dev',
        actor: 'member',
        environment: 'qa',
        answer: 'signs-in',
        at: SIGN_IN,
        status: 200,
      }),
    ]);
    // one POST, to the deployment the profile's environment names, in the field its route reads
    expect(seen).toEqual([{ url: SIGN_IN, body: { email: EMAIL, password: RIGHT } }]);
    const after = await profile();
    expect(after.actors.member).toMatchObject({ usable: true, checkedAt: expect.any(String) });
  });

  it('an account named identifier signs in under that name, and beside email is refused by name (ISS-1083)', async () => {
    const strapi = (extra: Record<string, unknown>) =>
      JSON.stringify({ loginRoute: '/api/auth/login', password: RIGHT, ...extra });
    const body = await ok(put('dev', 'qa', strapi({ identifier: EMAIL })));
    expect(body.signIn).toEqual([
      expect.objectContaining({ actor: 'member', answer: 'signs-in', at: STRAPI_SIGN_IN }),
    ]);
    expect(seen).toEqual([{ url: STRAPI_SIGN_IN, body: { identifier: EMAIL, password: RIGHT } }]);

    seen = [];
    const both = await ok(put('dev', 'qa', strapi({ identifier: EMAIL, email: EMAIL })));
    expect(both.signIn).toEqual([
      expect.objectContaining({ actor: 'member', answer: 'unprobeable' }),
    ]);
    expect(JSON.stringify(both.signIn)).toContain('names `email` and `identifier` at once');
    expect(seen).toEqual([]);
  });

  it('a value the environment refuses is refused by name, and the value held before is kept', async () => {
    await ok(put('dev', 'qa', secret(RIGHT)));
    const held = await storedValue();

    const res = await put('dev', 'qa', secret(WRONG));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const error = res.body.error as {
      code: string;
      refusals: { code: string; path: string; detail: string }[];
    };
    expect(error.refusals).toEqual([
      expect.objectContaining({
        code: 'SECRET_DOES_NOT_SIGN_IN',
        path: '/testing-profiles/dev/actors/member',
      }),
    ]);
    const detail = error.refusals[0]?.detail ?? '';
    for (const named of [
      'testing profile `dev`',
      'actor `member`',
      'environment `qa`',
      SIGN_IN,
      '401 INVALID_CREDENTIALS',
      'Nothing was written',
    ]) {
      expect(detail).toContain(named);
    }
    expect(await storedValue()).toBe(held);
    expect((await profile()).actors.member).toMatchObject({ usable: true });
  });

  it('a write made while the environment cannot answer is kept and flags the actor until one signs in', async () => {
    environment = 'down';
    const down = await ok(put('dev', 'qa', secret(RIGHT)));
    expect(down.signIn).toEqual([
      expect.objectContaining({ answer: 'unconfirmed', environment: 'qa', status: null }),
    ]);
    const flagged = (await profile()).actors.member;
    expect(flagged).toMatchObject({ usable: false, checkedAt: expect.any(String) });
    expect(flagged?.says).toContain('unusable');
    expect(flagged?.says).toContain('environment `qa`');
    expect(flagged?.says).toContain('could not be reached (ECONNREFUSED)');
    const listed = await ok(api(w.token, 'GET', `/api/projects/${w.projectId}/testing-profiles`));
    expect(listed.profiles).toContainEqual(
      expect.objectContaining({
        profileId: 'dev',
        signIn: expect.objectContaining({
          actors: { member: expect.objectContaining({ usable: false }) },
        }),
      }),
    );

    environment = 'busy';
    await ok(put('dev', 'qa', secret(RIGHT)));
    expect((await profile()).actors.member?.says).toContain('answered 503');

    environment = 'up';
    await ok(put('dev', 'qa', secret(RIGHT)));
    expect((await profile()).actors.member).toMatchObject({ usable: true });
  });

  it('a shape the probe cannot use is stored and named, and nothing is sent', async () => {
    const plain = await ok(put('dev', 'qa', `${EMAIL}:${RIGHT}`));
    expect(plain.signIn).toEqual([
      expect.objectContaining({ actor: 'member', answer: 'unprobeable' }),
    ]);
    expect(JSON.stringify(plain.signIn)).toContain('not the self-describing form');
    expect((await profile()).actors.member).toMatchObject({ usable: null });
    expect((await profile()).actors.member?.says).toContain('not probed');

    const key = await ok(put('dev', 'qa', JSON.stringify({ kind: 'api-key', key: RIGHT })));
    expect(JSON.stringify(key.signIn)).toContain('(kind `api-key`) names no `password`');

    // a path no environment's origin answers: the profile is named by no environment
    const lone = await ok(put('dev', 'lone', secret(RIGHT)));
    expect(lone.signIn).toEqual([
      expect.objectContaining({ profile: 'lone', actor: 'admin', answer: 'unprobeable' }),
    ]);
    expect(JSON.stringify(lone.signIn)).toContain('no environment names this profile');

    // a service's credential is the credential itself
    const store = await ok(put('dev', 'store-key', secret(RIGHT)));
    expect(store.signIn).toEqual([
      expect.objectContaining({ profile: 'dev', service: 'store', answer: 'unprobeable' }),
    ]);
    expect((await profile()).services.store?.says).toContain('not probed');
    expect(seen).toEqual([]);
  });

  it('no answer, log line or stored row holds the value or its account', async () => {
    // the integration run logs nothing (LOG_LEVEL silent): every line core would write is written here
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
    answers.push(await put('dev', 'qa', secret(RIGHT)));
    answers.push(await put('dev', 'qa', secret(WRONG)));
    environment = 'down';
    answers.push(await put('dev', 'qa', secret(WRONG)));
    answers.push(await put('dev', 'qa', `${EMAIL}:${RIGHT}`));
    answers.push(await api(w.token, 'GET', `/api/projects/${w.projectId}/testing-profiles/dev`));
    answers.push(await api(w.token, 'GET', `/api/projects/${w.projectId}/testing-profiles`));
    answers.push(await api(w.token, 'GET', `/api/projects/${w.projectId}/variables/events`));
    logger.level = level;
    expect(answers.map((a) => a.status)).toEqual([200, 422, 200, 200, 200, 200, 200]);
    expect(said.length, 'no line was written to watch').toBeGreaterThan(0);

    const tables = await rows<{ t: string }>(
      sql`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    for (const value of [RIGHT, WRONG, EMAIL]) {
      for (const a of answers) expect(JSON.stringify(a.body)).not.toContain(value);
      for (const line of said) expect(line).not.toContain(value);
      for (const { t } of tables) {
        const [hit] = await rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} AS r WHERE r::text LIKE ${`%${value}%`}`,
        );
        expect(hit?.n, `${t} holds the value`).toBe(0);
      }
    }
    // what is kept of a check: who, where, what it answered — no key could carry a value or length
    const audit = await rows<{ detail: { signIn?: Record<string, unknown>[] } }>(
      sql`SELECT detail FROM project_variable_events WHERE key = 'secret://dev/qa'`,
    );
    const keys = new Set(audit.flatMap((e) => (e.detail.signIn ?? []).flatMap(Object.keys)));
    const kept = ['actor', 'answer', 'at', 'code', 'environment', 'profile', 'says', 'status'];
    expect(keys.has('answer')).toBe(true);
    for (const k of keys) expect(kept, `a check keeps \`${k}\``).toContain(k);
  });
});
