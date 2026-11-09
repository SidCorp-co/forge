/**
 * A project secret declared for acting is read by the project's master, or by a declared run working
 * one of its issues, with no merge mark and no testing profile, and every read is recorded (REQ-88).
 * epod's master had to publish docs with `test-store/docs-epodsystem-key` and was refused at every
 * secret door there was, all three of them a testing profile's, so the key went into a file on the
 * box outside Forge (FB-521). Every other reader stays refused by name, and a testing profile's
 * secret keeps its own rule. Against real Postgres, over a stub value.
 *
 * @direct-test-of packages/core/src/project-config/acting-secret-door.ts
 * @direct-test-of packages/core/src/project-config/acting-secret-routes.ts
 * @direct-test-of packages/core/src/project-config/acting-secrets-schema.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { agentSessionsPorts } from '../../src/agent-sessions/ports.js';
import { mintPat } from '../../src/credentials/pat.js';
import { ensureMasterSession } from '../../src/devices/index.js';
import { logger } from '../../src/lib/logger.js';
import { actingSecretRefsOfSession } from '../../src/project-config/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  codeOf,
  declaredRun,
  ok,
  seedDeclaredRunWorld,
  REF as TESTING_REF,
  secrets as testingSecrets,
  world,
} from '../helpers/declared-run-secrets-world.js';
import { bindTestRunner, createTestDevice, createTestIssue, rows } from '../helpers/factories.js';

const ACTING = 'secret://test-store/docs-epodsystem-key';
const RUNS_ONLY = 'secret://test-store/runs-only-key';
const ACTING_VALUE = 'epod-docs-key-Zq8vN3pL5tR2wX7yK4mB';
const RUNS_VALUE = 'runs-only-key-Hd5sQ9wE2rT7yU4iO1p';

const door = (token: string, ref: string, run?: string, projectId = world.projectId) => {
  const [scope, name] = ref.replace('secret://', '').split('/');
  return api(
    token,
    'GET',
    `/api/projects/${projectId}/acting-secrets/${scope}/${name}${run ? `?run=${run}` : ''}`,
  );
};

/** The owner's own write of the project document, through `PUT /config`. */
async function declareActing(
  projectId: string,
  actingSecrets: unknown,
): Promise<{ status: number; body: unknown }> {
  const token = await userToken(world.ownerId);
  const held = (await ok(api(token, 'GET', `/api/projects/${projectId}/config`))) as {
    revision: number;
    document: Record<string, unknown>;
  };
  return api(token, 'PUT', `/api/projects/${projectId}/config`, {
    baseRevision: held.revision,
    document: { ...held.document, actingSecrets },
  });
}

/** The live resident master of `projectId` on `box`, opened as the box's registration opens it. */
async function liveMaster(projectId: string, box = world.box): Promise<string> {
  return (await ensureMasterSession({ deviceId: box, projectId, name: 'master' })).sessionId;
}

async function seedActing(): Promise<void> {
  const token = await userToken(world.ownerId);
  await ok(
    api(token, 'PUT', `/api/projects/${world.projectId}/secrets/test-store/docs-epodsystem-key`, {
      value: ACTING_VALUE,
    }),
  );
  await ok(
    api(token, 'PUT', `/api/projects/${world.projectId}/secrets/test-store/runs-only-key`, {
      value: RUNS_VALUE,
    }),
  );
  await ok(
    declareActing(world.projectId, [
      { secret: ACTING, readers: ['master', 'runs'] },
      { secret: RUNS_ONLY, readers: ['runs'] },
    ]),
  );
}

/** Every line the process logged while a case ran, as the logger was handed it. */
const logged: string[] = [];

beforeEach(async () => {
  await seedDeclaredRunWorld();
  await seedActing();
  logged.length = 0;
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? v.message : v)));
    }) as never);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BC-1: a project owner declares a secret for acting, naming its readers', () => {
  it('keeps the declaration on the project document, apart from the testing profiles', async () => {
    const token = await userToken(world.ownerId);
    const held = (await ok(api(token, 'GET', `/api/projects/${world.projectId}/config`))) as {
      document: { actingSecrets?: unknown };
    };
    expect(held.document.actingSecrets).toEqual([
      { secret: ACTING, readers: ['master', 'runs'] },
      { secret: RUNS_ONLY, readers: ['runs'] },
    ]);
    const profile = (await ok(
      api(token, 'GET', `/api/projects/${world.projectId}/testing-profiles/stg`),
    )) as { document: unknown };
    expect(JSON.stringify(profile.document)).not.toContain('docs-epodsystem-key');
  });

  it('refuses a reader that is neither the master nor runs, and a variable or owner-credential scope', async () => {
    for (const bad of [
      [{ secret: ACTING, readers: ['anyone'] }],
      [{ secret: ACTING, readers: [] }],
      [{ secret: 'secret://var/v-abc', readers: ['master'] }],
      [{ secret: 'secret://owner-acts/x', readers: ['master'] }],
      [{ secret: 'test-store/docs-epodsystem-key', readers: ['master'] }],
    ]) {
      const res = await declareActing(world.projectId, bad);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    }
  });
});

describe('BC-2: the master reads an acting secret with its box credential', () => {
  it('answers the value to the box holding the live master, with no merge mark and no profile', async () => {
    const session = await liveMaster(world.projectId);
    const res = await door(world.boxToken, ACTING);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      secret: ACTING,
      value: ACTING_VALUE,
      reader: { kind: 'master', session },
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses the master a secret declared for runs alone', async () => {
    await liveMaster(world.projectId);
    const res = await door(world.boxToken, RUNS_ONLY);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('ACTING_SECRET_READER_NOT_NAMED');
    expect(JSON.stringify(res.body)).not.toContain(RUNS_VALUE);
  });

  it('refuses a box holding no live master of the project', async () => {
    const res = await door(world.boxToken, ACTING);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('ACTING_SECRET_NOT_THE_MASTER');
  });

  it("refuses a person's credential, which is no reader", async () => {
    await liveMaster(world.projectId);
    const person = await mintPat({ userId: world.ownerId, name: 'mine', permissions: ['*'] });
    const res = await door(person.plaintext, ACTING);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('ACTING_SECRET_READER_NOT_NAMED');
  });

  it('refuses a secret declared for no acting', async () => {
    await liveMaster(world.projectId);
    const token = await userToken(world.ownerId);
    await ok(
      api(token, 'PUT', `/api/projects/${world.projectId}/secrets/test-store/undeclared`, {
        value: 'undeclared-value-123456',
      }),
    );
    const res = await door(world.boxToken, 'secret://test-store/undeclared');
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(codeOf(res.body)).toBe('ACTING_SECRET_NOT_DECLARED');
  });

  it("refuses a testing profile's secret through this door, and the testing door keeps TESTING_SECRETS_NOT_LANDED", async () => {
    await liveMaster(world.projectId);
    await ok(
      declareActing(world.projectId, [
        { secret: ACTING, readers: ['master', 'runs'] },
        { secret: TESTING_REF, readers: ['master', 'runs'] },
      ]),
    );
    const viaActing = await door(world.boxToken, TESTING_REF);
    expect(viaActing.status, JSON.stringify(viaActing.body)).toBe(422);
    expect(codeOf(viaActing.body)).toBe('ACTING_SECRET_TESTING_PROFILE_NAMES');
    await createTestIssue(world.projectId, world.ownerId, 70, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const run = await declaredRun(world.projectId, 70, { openedAt: 'in_progress' });
    const viaTesting = await testingSecrets(world.boxToken, run.boxRunId);
    expect(viaTesting.status, JSON.stringify(viaTesting.body)).toBe(422);
    expect(codeOf(viaTesting.body)).toBe('TESTING_SECRETS_NOT_LANDED');
  });
});

describe('BC-3: a declared run working an issue of the project reads it while it runs', () => {
  async function runOver(seq: number, over: Parameters<typeof declaredRun>[2] = {}) {
    await createTestIssue(world.projectId, world.ownerId, seq, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    return declaredRun(world.projectId, seq, { openedAt: 'in_progress', ...over });
  }

  it('answers a live run over an issue whose work has not landed', async () => {
    const run = await runOver(74);
    for (const id of [run.boxRunId, run.session, run.runId]) {
      const res = await door(world.boxToken, RUNS_ONLY, id);
      expect(res.status, `${id}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body).toMatchObject({
        secret: RUNS_ONLY,
        value: RUNS_VALUE,
        reader: { kind: 'run', id: run.runId, session: run.session },
      });
    }
  });

  it('refuses a run that has ended', async () => {
    const run = await runOver(75, { status: 'completed' });
    const res = await door(world.boxToken, RUNS_ONLY, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('ACTING_SECRET_RUN_ENDED');
  });

  it("refuses a run working another project's issue, served by the same box or not", async () => {
    await createTestIssue(world.otherId, world.ownerId, 3, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const unserved = await declaredRun(world.otherId, 3, { openedAt: 'in_progress' });
    const first = await door(world.boxToken, RUNS_ONLY, unserved.boxRunId);
    expect(first.status, JSON.stringify(first.body)).toBe(403);
    expect(codeOf(first.body)).toBe('ACTING_SECRET_RUN_OTHER_PROJECT');

    await bindTestRunner(world.otherId, world.box);
    const served = await declaredRun(world.otherId, 3, { openedAt: 'in_progress' });
    const second = await door(world.boxToken, RUNS_ONLY, served.boxRunId);
    expect(second.status, JSON.stringify(second.body)).toBe(403);
    expect(codeOf(second.body)).toBe('ACTING_SECRET_RUN_OTHER_PROJECT');
  });

  it('refuses a run core holds no record of on this box', async () => {
    const elsewhere = await createTestDevice(world.ownerId);
    const run = await runOver(76, { box: elsewhere });
    for (const id of [run.boxRunId, randomUUID()]) {
      const res = await door(world.boxToken, RUNS_ONLY, id);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(codeOf(res.body)).toBe('ACTING_SECRET_RUN_NOT_RECORDED');
    }
  });
});

describe('BC-4: every read is recorded, and the value leaves only in the read', () => {
  it('writes one audit row per read naming who, which secret, the run and when; never the value', async () => {
    const master = await liveMaster(world.projectId);
    const ended = await declaredRun(world.projectId, 77, { status: 'completed' });
    await createTestIssue(world.projectId, world.ownerId, 77, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const ran = await declaredRun(world.projectId, 77, { openedAt: 'in_progress' });
    const before = Date.now();
    expect((await door(world.boxToken, ACTING)).status).toBe(200);
    expect((await door(world.boxToken, ACTING, ran.boxRunId)).status).toBe(200);
    // refusals answer no value and write no read
    const refusals = [
      await door(world.boxToken, RUNS_ONLY),
      await door(world.boxToken, ACTING, ended.boxRunId),
    ];
    const audit = await rows<{ act: string; key: string; actor_id: string; detail: unknown }>(sql`
      SELECT act, key, actor_id, detail, at FROM project_variable_events
       WHERE project_id = ${world.projectId} AND detail ? 'acting' ORDER BY at, id`);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      act: 'delivered',
      key: ACTING,
      actor_id: world.ownerId,
      detail: { acting: { reader: 'master', box: world.box, session: master } },
    });
    expect(audit[1]).toMatchObject({
      act: 'delivered',
      key: ACTING,
      detail: { acting: { reader: 'runs', session: ran.session, run: ran.runId } },
    });
    const everything = JSON.stringify({ audit, logged, refusals: refusals.map((r) => r.body) });
    expect(everything).not.toContain(ACTING_VALUE);
    expect(everything).not.toContain(RUNS_VALUE);

    const token = await userToken(world.ownerId);
    const record = (await ok(
      api(token, 'GET', `/api/projects/${world.projectId}/acting-secrets`),
    )) as { declared: unknown[]; reads: Array<Record<string, unknown>> };
    expect(record.declared).toEqual([
      expect.objectContaining({ secret: ACTING, readers: ['master', 'runs'] }),
      expect.objectContaining({ secret: RUNS_ONLY, readers: ['runs'] }),
    ]);
    expect(record.reads).toHaveLength(2);
    expect(record.reads.map((r) => r.reader).sort()).toEqual(['master', 'runs']);
    for (const r of record.reads) {
      expect(r).toMatchObject({ secret: ACTING, actor: world.ownerId });
      expect(Date.parse(String(r.at))).toBeGreaterThanOrEqual(before - 1000);
    }
    expect(JSON.stringify(record)).not.toContain(ACTING_VALUE);
    const events = await ok(api(token, 'GET', `/api/projects/${world.projectId}/variables/events`));
    expect(JSON.stringify(events)).not.toContain(ACTING_VALUE);
  });

  it("scrubs the value from what the reading session posts, the master's and the run's", async () => {
    const master = await liveMaster(world.projectId);
    expect((await door(world.boxToken, ACTING)).status).toBe(200);
    const posted = await agentSessionsPorts().scrubSessionOutput(master, {
      line: `published with ${ACTING_VALUE}`,
    });
    expect(JSON.stringify(posted)).not.toContain(ACTING_VALUE);
    // the audit row is what names it after a restart, when nothing is held in memory
    expect(await actingSecretRefsOfSession(master)).toEqual([
      { projectId: world.projectId, refs: [ACTING] },
    ]);
  });

  it('points the secrets list and the guessed path at the acting door, and serves no value there', async () => {
    const token = await userToken(world.ownerId);
    const list = await ok(api(token, 'GET', `/api/projects/${world.projectId}/secrets`));
    expect(JSON.stringify(list)).toContain(
      `GET /api/projects/${world.projectId}/acting-secrets/test-store/docs-epodsystem-key`,
    );
    const guessed = await api(
      token,
      'GET',
      `/api/projects/${world.projectId}/secrets/test-store/docs-epodsystem-key`,
    );
    expect(guessed.status).toBe(404);
    expect(JSON.stringify(guessed.body)).toContain(
      '/acting-secrets/test-store/docs-epodsystem-key',
    );
    expect(JSON.stringify([list, guessed.body])).not.toContain(ACTING_VALUE);
  });
});
