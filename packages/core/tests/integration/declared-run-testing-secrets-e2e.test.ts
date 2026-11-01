/**
 * A judging run a master declared reads its project's testing-profile secrets (adminhub-fe,
 * 2026-10-27: the stg judges of ISS-68, run 0297b792, were refused
 * `TESTING_SECRETS_NOT_A_JOB_CREDENTIAL` with every id they held, and the account went into a 0600
 * file on the box). A declared run executes in its master's pane under the box's credential, so the
 * token cannot say which run calls; the call names it, as a verdict's `run` does. Core admitted that
 * run on that box for that project, which is what binds the read to both. Still refused by name: a
 * box credential naming no run, a run of another project, a run that ended, and one not admitted.
 * A run read in the seconds between its declaration and the box's sweep that records it at core
 * (catalog-fe ISS-39, run ff22a502, 2026-10-30: read 0-27 s after declaring, refused
 * `TESTING_SECRETS_NOT_A_JOB_CREDENTIAL`, closed as never started) is refused as not recorded yet,
 * naming the sweep and the same id to read again with. Against real Postgres.
 *
 * @direct-test-of packages/core/src/project-config/testing-secrets.ts
 * @direct-test-of packages/core/src/devices/declared-run-of-call.ts
 * @direct-test-of packages/core/src/project-config/secret-value-door.ts
 * @direct-test-of packages/core/src/project-config/testing-secret-values.ts
 * @direct-test-of packages/core/src/project-config/testing-secrets-routes.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the testing secret is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
} from '@forge/contracts/agent-sessions';
import { agentSessionsPorts } from '../../src/agent-sessions/ports.js';
import { mintPat } from '../../src/credentials/pat.js';
import { deviceTokenNameFor, workspaceTokenNameFor } from '../../src/credentials/pat-format.js';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const VALUE = 'stg-admin@adminhub.test:Corr3ct-H0rse-Battery';
const REF = 'secret://test/stg-admin';

const world = { ownerId: '', projectId: '', otherId: '', box: '', boxToken: '' };

async function ok(r: Promise<{ status: number; body: unknown }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

/** A project whose `stg` environment deploys `release/stg` and names testing profile `stg`. */
async function judgedProject(projectId: string): Promise<void> {
  const token = await userToken(world.ownerId);
  await ok(
    api(token, 'PUT', `/api/projects/${projectId}/secrets/test/stg-admin`, { value: VALUE }),
  );
  await ok(
    api(token, 'PUT', `/api/projects/${projectId}/testing-profiles/stg`, {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
        version: 1,
        id: 'stg',
        actors: { admin: { role: 'project-admin', credential: REF } },
        services: {},
        limits: [],
      },
    }),
  );
  await seedProjectDocument(projectId, world.ownerId, {
    defaultBranch: 'main',
    promotions: [{ from: 'release/stg', to: 'main', via: 'merge' }],
    environments: {
      stg: {
        tier: 'staging',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external' },
        testing: 'stg',
      },
    },
  });
}

/** ISS-`seq`, landed on `release/stg` and standing at awaiting_release. */
async function landedIssue(projectId: string, seq: number): Promise<string> {
  const { id } = await createTestIssue(projectId, world.ownerId, seq, {
    status: 'awaiting_release',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  await db.execute(sql`UPDATE issues SET merged_target = 'release/stg' WHERE id = ${id}`);
  return id;
}

/** A run the box's master declared over ISS-`seq`; answers its ids. */
async function declaredRun(
  projectId: string,
  seq: number,
  over: { box?: string; status?: string; openedAt?: string; boxRunId?: string } = {},
): Promise<{ boxRunId: string; runId: string; session: string }> {
  const boxRunId = over.boxRunId ?? randomUUID();
  const runId = randomUUID();
  const key = `ISS-${seq}`;
  const metadata = {
    boxRunId,
    [RUN_GROUP_METADATA_KEY]: [key],
    [RUN_ISSUE_STATUSES_METADATA_KEY]: { [key]: over.openedAt ?? 'awaiting_release' },
  };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${projectId}, 'system', 'running', now(), ${JSON.stringify(metadata)}::jsonb)`);
  const [s] = await rows<{ id: string }>(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
    VALUES (${projectId}, ${over.box ?? world.box}, ${runId}, 'run_session', ${over.status ?? 'running'}, now(), now())
    RETURNING id`);
  if (!s) throw new Error('no run session seeded');
  return { boxRunId, runId, session: s.id };
}

const secrets = (token: string, id: string, query = 'actor=admin') =>
  api(token, 'GET', `/api/jobs/${id}/testing-profiles/stg/secrets${query ? `?${query}` : ''}`);

const codeOf = (body: unknown): string | undefined => {
  const b = body as { code?: string; error?: { code?: string } };
  return b.error?.code ?? b.code;
};

beforeEach(async () => {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  world.otherId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  await addProjectMember(world.otherId, world.ownerId, 'admin');
  world.box = await createTestDevice(world.ownerId);
  await bindTestRunner(world.projectId, world.box);
  // the box's own credential, which a master's pane and every run it declares call with
  world.boxToken = (
    await mintPat({
      userId: world.ownerId,
      name: deviceTokenNameFor(world.box),
      scopes: ['read', 'write'],
      permissions: ['*'],
      // as `devices/credential.ts:issueDeviceCredential` mints a box a person paired: fenced to none
      projectIds: [],
      onBehalfOf: world.ownerId,
      deviceId: world.box,
    })
  ).plaintext;
  await judgedProject(world.projectId);
});

describe('a run a master declared reads the testing secrets of the environment it judges', () => {
  it('answers the stg profile to the box credential naming the run by the id the box declared', async () => {
    const issueId = await landedIssue(world.projectId, 68);
    const run = await declaredRun(world.projectId, 68);
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      jobId: null,
      run: { session: run.session, id: run.runId },
      environment: 'stg',
      profileId: 'stg',
      secrets: [{ ref: REF, value: VALUE }],
    });
    const audit = await rows<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM activity_log WHERE issue_id = ${issueId} AND action = 'testing_secrets.resolved'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({
      sessionId: run.session,
      refs: [REF],
      profile: 'stg',
    });
    expect(JSON.stringify(audit)).not.toContain(VALUE);
  });

  it("answers to core's session id and run id for the run as well", async () => {
    await landedIssue(world.projectId, 68);
    const run = await declaredRun(world.projectId, 68);
    for (const id of [run.session, run.runId]) {
      const res = await secrets(world.boxToken, id);
      expect(res.status, `${id}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });

  it("scrubs the value from what the run's session posts", async () => {
    await landedIssue(world.projectId, 68);
    const run = await declaredRun(world.projectId, 68);
    expect((await secrets(world.boxToken, run.boxRunId)).status).toBe(200);
    const posted = await agentSessionsPorts().scrubSessionOutput(run.session, {
      line: `logged in with ${VALUE}`,
    });
    expect(JSON.stringify(posted)).not.toContain(VALUE);
  });
});

describe('everything else stays refused by name', () => {
  it('refuses a run declared and not yet recorded at core as not recorded, and answers the same id once it is', async () => {
    await landedIssue(world.projectId, 68);
    const declared = randomUUID();
    const early = await secrets(world.boxToken, declared);
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(codeOf(early.body)).toBe('TESTING_SECRETS_RUN_NOT_RECORDED');
    const said = JSON.stringify(early.body);
    expect(said).toContain(declared);
    expect(said).toContain('sweep');
    expect(said).toContain('is now core session');
    // the box's next sweep opens the run's session: the same id now reads
    const run = await declaredRun(world.projectId, 68, { boxRunId: declared });
    const later = await secrets(world.boxToken, declared);
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    expect(later.body).toMatchObject({ run: { session: run.session, id: run.runId } });
  });

  it('refuses `self` under a box credential, naming the run id to call with instead', async () => {
    const res = await secrets(world.boxToken, 'self');
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_NOT_A_JOB_CREDENTIAL');
    expect(JSON.stringify(res.body)).toContain('in place of `self`');
    // adminhub-api's ISS-49 and ISS-85 judges (2026-10-30) sent `self` from their own checkouts:
    // the refusal says the box names the run there, so a `self` arriving here came from elsewhere
    expect(JSON.stringify(res.body)).toContain(
      "Sent with `forge-runner api` from inside a declared run's own checkout, `self` arrives here as that run's id",
    );
  });

  it('refuses a run another box declared', async () => {
    await landedIssue(world.projectId, 68);
    const elsewhere = await createTestDevice(world.ownerId);
    const run = await declaredRun(world.projectId, 68, { box: elsewhere });
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_RUN_NOT_RECORDED');
    expect(JSON.stringify(res.body)).toContain('declared on another box');
  });

  it("refuses a run of another project than the one the caller's credential is bound to", async () => {
    await judgedProject(world.otherId);
    await landedIssue(world.otherId, 3);
    const run = await declaredRun(world.otherId, 3);
    const bound = await mintPat({
      userId: world.ownerId,
      name: workspaceTokenNameFor(world.box, world.projectId),
      scopes: ['read', 'write'],
      permissions: ['*'],
      projectIds: [world.projectId],
      deviceId: world.box,
    });
    const res = await secrets(bound.plaintext, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_FOREIGN_RUN');
  });

  it("refuses the box's own credential a run of a project the box does not serve", async () => {
    await judgedProject(world.otherId);
    await landedIssue(world.otherId, 3);
    const run = await declaredRun(world.otherId, 3);
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_FOREIGN_RUN');
  });

  it('refuses a run that has ended', async () => {
    await landedIssue(world.projectId, 68);
    const run = await declaredRun(world.projectId, 68, { status: 'completed' });
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_RUN_ENDED');
  });

  it('refuses a run core has not admitted', async () => {
    await landedIssue(world.projectId, 68);
    const run = await declaredRun(world.projectId, 68, { status: 'queued' });
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_RUN_NOT_ADMITTED');
  });

  it('refuses a run over work that has not landed, which names no environment', async () => {
    await createTestIssue(world.projectId, world.ownerId, 70, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const run = await declaredRun(world.projectId, 70, { openedAt: 'in_progress' });
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_NOT_LANDED');
  });

  it("refuses a person's credential, which is no run", async () => {
    await landedIssue(world.projectId, 68);
    const run = await declaredRun(world.projectId, 68);
    const person = await mintPat({ userId: world.ownerId, name: 'mine', permissions: ['*'] });
    const res = await secrets(person.plaintext, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_NOT_A_JOB_CREDENTIAL');
  });
});

// adminhub-api FB-379 (run 1951bc09, ISS-49, 2026-10-30): a declared qa run's read went out on a
// credential that carries no box and was told only the generic job-credential shape, so it fell back
// to a local file. The refusal now names the box the run was declared on and the call that goes out
// under that box's credential.
describe('a declared run read under a credential that carries no box', () => {
  it('is refused naming the box the run was declared on and the call to send from its pane', async () => {
    await landedIssue(world.projectId, 49);
    const run = await declaredRun(world.projectId, 49);
    const [box] = await rows<{ name: string }>(
      sql`SELECT name FROM devices WHERE id = ${world.box}`,
    );
    const person = await mintPat({ userId: world.ownerId, name: 'mine', permissions: ['*'] });
    for (const id of [run.boxRunId, run.session]) {
      const res = await secrets(person.plaintext, id);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(codeOf(res.body)).toBe('TESTING_SECRETS_NOT_A_JOB_CREDENTIAL');
      const said = JSON.stringify(res.body);
      expect(said).toContain(`${id} is a run declared on box ${box?.name} over ISS-49`);
      expect(said).toContain(`forge-runner api jobs/${id}/testing-profiles/stg/secrets`);
      expect(said).not.toContain(VALUE);
    }
  });

  it('names no run of a project the account is no member of', async () => {
    await judgedProject(world.otherId);
    await landedIssue(world.otherId, 3);
    const run = await declaredRun(world.otherId, 3);
    const stranger = (await createTestUser({ verified: true })).id;
    const theirs = await mintPat({ userId: stranger, name: 'theirs', permissions: ['*'] });
    const res = await secrets(theirs.plaintext, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_NOT_A_JOB_CREDENTIAL');
    expect(JSON.stringify(res.body)).not.toContain('is a run declared on box');
  });
});

// adminhub-api run 194c71e4 on dev core, 2026-10-30: a declared qa run over profile stg read seven
// routes looking for the value, found neither a value nor a pointer, and gave up. Each read it made
// now names the one door; none serves the value.
describe('a judge looking for a testing secret is pointed at the one door by every read it tries', () => {
  const AT = '/api/jobs/<run id>/testing-profiles/stg/secrets';
  const TEMPLATE = `${AT}?actor=<actor>`;
  const BY_REF = `${AT}?ref=${REF}`;

  it('the profile, the guessed paths and the secrets list each name the jobs route, and none the value', async () => {
    // read as the project member the run acts for, whose reads reach the project's routes
    const member = await userToken(world.ownerId);
    const at = (path: string) => api(member, 'GET', `/api/projects/${world.projectId}${path}`);
    const answers: Array<[string, { status: number; body: unknown }]> = [];
    for (const path of [
      '/testing-profiles/stg',
      '/testing-profiles/stg/credentials',
      '/testing-profiles/stg/resolve',
      '/testing-profiles/stg/secrets',
      '/test-credentials',
      '/secrets/test/stg-admin',
      '/secrets',
    ]) {
      answers.push([path, await at(path)]);
    }
    for (const [path, res] of answers) {
      const text = JSON.stringify(res.body);
      expect(text, `${path} names no door: ${text}`).toContain(
        '/api/jobs/<run id>/testing-profiles/',
      );
      expect(text, `${path} served the value`).not.toContain(VALUE);
    }
    const byPath = new Map(answers);
    const profile = byPath.get('/testing-profiles/stg')?.body as {
      valueDoor?: { route?: string; doors?: string[] };
    };
    // one door per actor: no pointer reads the whole profile (ISS-868)
    expect(profile.valueDoor?.route).toBe(`GET ${TEMPLATE}`);
    expect(profile.valueDoor?.doors).toEqual([`GET ${AT}?actor=admin`]);
    for (const [path, door] of [
      ['/testing-profiles/stg/credentials', TEMPLATE],
      ['/testing-profiles/stg/resolve', TEMPLATE],
      ['/testing-profiles/stg/secrets', TEMPLATE],
      ['/secrets/test/stg-admin', BY_REF],
    ] as const) {
      const res = byPath.get(path);
      expect([res?.status, codeOf(res?.body)], path).toEqual([
        404,
        'TESTING_SECRET_READ_ELSEWHERE',
      ]);
      expect(JSON.stringify(res?.body), path).toContain(door);
    }
    expect(codeOf(byPath.get('/test-credentials')?.body)).toBe('TESTING_SECRET_READ_ELSEWHERE');
    const list = byPath.get('/secrets')?.body as {
      secrets: Array<{ ref: string; valueAt: string[] }>;
    };
    expect(list.secrets).toEqual([
      expect.objectContaining({ ref: REF, valueAt: [`GET ${BY_REF}`] }),
    ]);
  });

  it('the doors it names answer the declared run', async () => {
    await landedIssue(world.projectId, 68);
    const run = await declaredRun(world.projectId, 68);
    for (const door of [`${AT}?actor=admin`, BY_REF]) {
      const res = await api(world.boxToken, 'GET', door.replace('<run id>', run.boxRunId));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ secrets: [{ ref: REF, value: VALUE }] });
    }
  });
});

// FB-464 (catalog-api qa runs 94ef974e and 575d3ace, 2026-11-01): a judge needing one actor was
// handed every secret of the profile, a service key to another system among them, and printed them
// into its transcript. A read names the one secret it needs and receives only that (ISS-868).
describe('a run receives only the one secret it names', () => {
  const VIEWER = 'stg-viewer@adminhub.test:An0ther-Stap1e-Phrase';
  const VIEWER_REF = 'secret://test/stg-viewer';
  const STORE = 'store-service-key:9f8e7d6c5b4a3210-planted';
  const STORE_REF = 'secret://dev/epod-store';

  beforeEach(async () => {
    const token = await userToken(world.ownerId);
    for (const [scope, name, value] of [
      ['test', 'stg-viewer', VIEWER],
      ['dev', 'epod-store', STORE],
    ] as const) {
      await ok(
        api(token, 'PUT', `/api/projects/${world.projectId}/secrets/${scope}/${name}`, { value }),
      );
    }
    await ok(
      api(token, 'PUT', `/api/projects/${world.projectId}/testing-profiles/stg`, {
        baseRevision: 1,
        document: {
          $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
          version: 1,
          id: 'stg',
          actors: {
            admin: { role: 'project-admin', credential: REF },
            viewer: { role: 'viewer', credential: VIEWER_REF },
          },
          services: { store: { access: 'readonly', credential: STORE_REF } },
          limits: [],
        },
      }),
    );
  });

  async function run() {
    await landedIssue(world.projectId, 68);
    return declaredRun(world.projectId, 68);
  }

  it('refuses a read naming no secret, listing the names and no value', async () => {
    const { boxRunId } = await run();
    const res = await secrets(world.boxToken, boxRunId, '');
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('TESTING_SECRET_UNCHOSEN');
    const text = JSON.stringify(res.body);
    expect(text).toContain('actors admin, viewer');
    expect(text).toContain('services store');
    for (const value of [VALUE, VIEWER, STORE]) expect(text).not.toContain(value);
  });

  it('answers actor A with A’s secret alone: neither B’s nor the service’s value is in the body', async () => {
    const { boxRunId } = await run();
    const res = await secrets(world.boxToken, boxRunId, 'actor=admin');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ secrets: [{ ref: REF, value: VALUE }] });
    expect((res.body as { secrets: unknown[] }).secrets).toHaveLength(1);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(VIEWER);
    expect(text).not.toContain(STORE);
    expect(text).not.toContain(STORE_REF);
  });

  it('answers a service, or one ref, by its name alone', async () => {
    const { boxRunId } = await run();
    const service = await secrets(world.boxToken, boxRunId, 'service=store');
    expect(service.status, JSON.stringify(service.body)).toBe(200);
    expect((service.body as { secrets: unknown[] }).secrets).toEqual([
      { ref: STORE_REF, value: STORE },
    ]);
    const byRef = await secrets(world.boxToken, boxRunId, `ref=${VIEWER_REF}`);
    expect((byRef.body as { secrets: unknown[] }).secrets).toEqual([
      { ref: VIEWER_REF, value: VIEWER },
    ]);
  });

  it('refuses a name the profile does not declare, listing the valid names and no value', async () => {
    const { boxRunId } = await run();
    for (const query of ['actor=ghost', 'service=ghost', 'ref=secret://test/ghost']) {
      const res = await secrets(world.boxToken, boxRunId, query);
      expect([res.status, codeOf(res.body)], query).toEqual([422, 'SECRET_NOT_NAMED']);
      const text = JSON.stringify(res.body);
      expect(text, query).toContain('actors admin, viewer; services store');
      for (const value of [VALUE, VIEWER, STORE]) expect(text, query).not.toContain(value);
    }
  });

  it('refuses a read naming two secrets, or one twice', async () => {
    const { boxRunId } = await run();
    const two = await secrets(world.boxToken, boxRunId, 'actor=admin&service=store');
    expect([two.status, codeOf(two.body)]).toEqual([422, 'TESTING_SECRET_ONE_PER_READ']);
    const twice = await secrets(world.boxToken, boxRunId, 'actor=admin&actor=viewer');
    expect([twice.status, codeOf(twice.body)]).toEqual([400, 'SECRET_REF_SHAPE']);
    for (const res of [two, twice]) {
      const text = JSON.stringify(res.body);
      for (const value of [VALUE, VIEWER, STORE]) expect(text).not.toContain(value);
    }
  });

  it('lists no name to a caller the route refuses: the run is known before the profile is', async () => {
    const res = await secrets(world.boxToken, randomUUID(), '');
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain('viewer');
  });
});
