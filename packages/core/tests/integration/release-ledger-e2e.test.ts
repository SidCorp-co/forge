/**
 * ISS-1042 — a release run that can be read by somebody other than the session
 * that ran it.
 *
 * Between `createReleaseBatch` and `finish` core recorded nothing at all, so a
 * release that merged, deployed twice, failed a probe and deployed again left
 * one `pipeline_runs` row saying `running` and a transcript on whichever box
 * held it. Kill that session and the next agent had the roster and nothing
 * else — no way to tell a release that had done nothing from one that had
 * already promoted.
 *
 * Integration and through the real route mount, because every claim here is
 * about a row or about what a caller is refused: the idempotency rule is one
 * unique constraint, the machine-verdict refusal is one route body, and the
 * state read is four readers that have to agree about one run.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

let probe: Server;
let served = 'commit-before';
let probeUrl = '';

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';

  const [batch, jwt, err] = await Promise.all([
    import('../../src/release-batch/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwt.signUserToken;
  app = new Hono();
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.onError(err.errorHandler);

  probe = createServer((_req, res) => res.end(served));
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
}, 60_000);

afterAll(async () => {
  if (probe) await new Promise<void>((done) => probe.close(() => done()));
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  served = 'commit-before';
});

interface World {
  projectId: string;
  userId: string;
  token: string;
  runId: string;
}

async function seed(opts: { probes?: boolean } = {}): Promise<World> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  const connection = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connection}, 'user', ${user.id}, 'coolify', true)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
    VALUES (${connection}, ${project.id}, 'coolify', 'deploy', ARRAY['live'], true, ${JSON.stringify(
      opts.probes === false
        ? { releaseRunnerLabel: 'box' }
        : {
            releaseRunnerLabel: 'box',
            verify: { probes: [{ url: probeUrl }], timeoutSeconds: 5, stableReads: 1 },
          },
    )}::jsonb)
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
    VALUES (${runId}, ${project.id}, 'system', 'running',
            ${JSON.stringify({ source: 'release-batch' })}::jsonb)
  `);
  return { projectId: project.id, userId: user.id, token: await signUserToken(user.id), runId };
}

function call(path: string, token: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

const base = (w: World) => `/api/projects/${w.projectId}/release-batches/${w.runId}`;

/**
 * The shape of `GET .../state`, named so a case reads a field rather than an
 * index into an untyped bag.
 */
// cm:guard written out rather than imported from `state.ts`: what these cases assert is what the
// route SERIALISES, and typing them by the server's own interface would make a field the JSON does
// not carry a type error nowhere — the assertion would then be about the import, not the wire.
interface StateBody {
  roster: unknown;
  attempts: Array<{
    account: string | null;
    verdict: string | null;
    health: string | null;
    identity: string | null;
  }>;
  live: { health: string; identity: string | null } | null;
  bounds: { holding: boolean; crossedNames: string[]; bounds: Array<{ name: string }> };
  method: { loaded: boolean; detail: string | null } | null;
  methodUnloaded: boolean;
}

const state = async (w: World): Promise<StateBody> =>
  (await (await call(`${base(w)}/state`, w.token)).json()) as StateBody;

const openAttempt = (w: World, body: Record<string, unknown>) =>
  call(`${base(w)}/attempts`, w.token, { method: 'POST', body: JSON.stringify(body) });

const postAccount = (w: World, key: string, body: Record<string, unknown>) =>
  call(`${base(w)}/attempts/${key}/account`, w.token, {
    method: 'POST',
    body: JSON.stringify(body),
  });

const rows = async (runId: string) =>
  harness.db.execute(sql`
    SELECT * FROM release_attempts WHERE run_id = ${runId} ORDER BY started_at, id
  `);

describe('an attempt is on the record before the act it describes', () => {
  // cm:guard criterion 11. A ledger written after the fact records only what FINISHED, so a
  // release killed mid-deploy leaves nothing — and that is the release worth reading about. The
  // assertion is that the row exists with no verdict at all, which is what an act in flight is.
  it('records the intent with no verdict, before anything is reported back', async () => {
    const w = await seed();

    const res = await openAttempt(w, {
      stage: 'deploy',
      idempotencyKey: 'deploy-1',
      commit: 'abc',
    });

    expect(res.status).toBe(201);
    const [row] = await rows(w.runId);
    expect(row).toMatchObject({
      stage: 'deploy',
      idempotency_key: 'deploy-1',
      commit: 'abc',
      verdict: null,
      health: null,
      settled_at: null,
    });
  });

  // cm:guard criterion 12. Two rows for one key would make "how many times did this release
  // deploy" unanswerable, which is the first question anybody asks of a stuck release.
  it('updates the existing row when the same key is re-sent under one run', async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'deploy', idempotencyKey: 'deploy-1', commit: 'abc' });

    await openAttempt(w, { stage: 'deploy', idempotencyKey: 'deploy-1', commit: 'def' });

    const all = await rows(w.runId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ commit: 'def' });
  });

  // cm:guard criterion 13, and it is why the constraint is on the PAIR. Two runs retrying
  // `deploy-1` are two acts on two rosters, and a key-only unique would hand one release the
  // other's readings.
  it('gives the same key its own row under a different run', async () => {
    const a = await seed();
    const b = await seed();
    await openAttempt(a, { stage: 'deploy', idempotencyKey: 'deploy-1' });

    const res = await openAttempt(b, { stage: 'deploy', idempotencyKey: 'deploy-1' });

    expect(res.status).toBe(201);
    expect(await rows(a.runId)).toHaveLength(1);
    expect(await rows(b.runId)).toHaveLength(1);
  });

  // cm:guard re-opening CLEARS the machine half. A second attempt under one key is a fresh act,
  // and leaving the previous verdict would have the bounds read a settled failure as this
  // attempt's outcome while it is still in flight.
  it('clears the previous verdict when a key is attempted again', async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'deploy', idempotencyKey: 'deploy-1' });
    await postAccount(w, 'deploy-1', { account: 'deployed' });

    await openAttempt(w, { stage: 'deploy', idempotencyKey: 'deploy-1' });

    const [row] = await rows(w.runId);
    expect(row).toMatchObject({ verdict: null, health: null, settled_at: null });
  });
});

describe('the account and the verdict are two parties about one act', () => {
  // cm:guard criterion 14. `.strict()` would drop these with "unrecognized key"; the refusal has
  // to say where the verdict comes from instead, or the next caller sends it again under a
  // different spelling. The whole table exists because "the release happened" used to be a
  // sentence an agent wrote.
  it('refuses an agent-supplied machine verdict by name, and says where it comes from', async () => {
    const w = await seed();

    const res = await openAttempt(w, {
      stage: 'deploy',
      idempotencyKey: 'deploy-1',
      verdict: 'ok',
      health: 'up',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      details: { keys: string[] };
      message: string;
    };
    expect(body.code).toBe('RELEASE_VERDICT_NOT_YOURS');
    expect(body.details.keys.sort()).toEqual(['health', 'verdict']);
    expect(body.message).toContain("core's reading and not yours");
  });

  it('refuses the same keys on the account route', async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'deploy', idempotencyKey: 'deploy-1' });

    const res = await postAccount(w, 'deploy-1', { account: 'it worked', identity: 'abc' });

    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'RELEASE_VERDICT_NOT_YOURS',
    });
  });

  // cm:guard criteria 10 and 15. The agent's words and core's own reading are stored side by side
  // and neither is derived from the other; the `providerRef` is the caller's because a Coolify
  // deployment uuid is a fact only the caller holds.
  it('stores the account beside a verdict core read for itself', async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'deploy', idempotencyKey: 'deploy-1', commit: 'abc' });
    served = 'commit-after';

    await postAccount(w, 'deploy-1', {
      account: 'merged to production and redeployed',
      providerRef: 'coolify-dep-9',
    });

    const [row] = await rows(w.runId);
    expect(row).toMatchObject({
      account: 'merged to production and redeployed',
      provider_ref: 'coolify-dep-9',
      health: 'up',
      identity: 'commit-after',
      verdict: 'ok',
    });
    expect(row?.settled_at).not.toBeNull();
  });

  // cm:guard the verdict must be able to CONTRADICT the account, or it is decoration. Here the
  // agent says the deploy landed and the probe cannot be reached.
  it("reads the application down while the agent's account says it landed", async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'deploy', idempotencyKey: 'deploy-1' });
    await new Promise<void>((done) => probe.close(() => done()));

    await postAccount(w, 'deploy-1', { account: 'deploy succeeded, everything green' });

    const [row] = await rows(w.runId);
    expect(row).toMatchObject({ health: 'down', verdict: 'failed' });
    expect(String(row?.verdict_reason)).toContain('not answering');

    probe = createServer((_req, res) => res.end(served));
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
  });

  // cm:guard criterion 17. A truncation nobody is told about reads as the whole of it, and an
  // operator debugging a failed deploy then believes they have seen the error. Two columns: it was
  // cut, and nobody has read past the cut.
  it('marks a machine-cut log tail as cut and as read by nobody', async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'deploy', idempotencyKey: 'deploy-1' });

    await postAccount(w, 'deploy-1', { account: 'see the log', logTail: 'x'.repeat(20_000) });

    const [row] = await rows(w.runId);
    expect(row).toMatchObject({ log_tail_truncated: true, log_tail_read_at: null });
    expect(String(row?.log_tail)).toHaveLength(8_000);
  });

  it('leaves a short tail unmarked, so the flag means something', async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'deploy', idempotencyKey: 'deploy-1' });

    await postAccount(w, 'deploy-1', { account: 'short', logTail: 'all of it' });

    const [row] = await rows(w.runId);
    expect(row).toMatchObject({ log_tail_truncated: false, log_tail: 'all of it' });
  });

  // cm:guard an account for an act nobody declared is REFUSED, not absorbed into a fresh row. The
  // order is the design: an account with no intent before it is an act core never knew was
  // happening, and inventing the row would put the after-the-fact ledger back.
  it('refuses an account for an attempt that was never opened', async () => {
    const w = await seed();

    const res = await postAccount(w, 'never-opened', { account: 'I did a thing' });

    expect(res.status).toBe(404);
    expect(await rows(w.runId)).toHaveLength(0);
  });
});

describe('the state route answers from the world', () => {
  // cm:guard criteria 16 and 18. The live reading is taken at REQUEST TIME and never served from
  // the newest attempt row: the ledger says what production looked like at each act, and this
  // question is what it looks like now.
  it('answers with the roster, the ledger, a live reading and the three bounds', async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'promote', idempotencyKey: 'promote-1', commit: 'abc' });
    served = 'commit-after';
    await postAccount(w, 'promote-1', { account: 'merged and deployed' });

    const res = await call(`${base(w)}/state`, w.token);

    expect(res.status).toBe(200);
    const body = (await res.json()) as StateBody;
    expect(body.roster).toBeDefined();
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]).toMatchObject({
      account: 'merged and deployed',
      verdict: 'ok',
      health: 'up',
      identity: 'commit-after',
    });
    expect(body.live).toMatchObject({ health: 'up', identity: 'commit-after' });
    expect(body.bounds.bounds.map((b) => b.name)).toEqual(['total', 'stall', 'regression']);
  });

  // cm:guard the live reading moves and the ledger does not. Without this the two could be one
  // value read twice, which is exactly the collapse the state route exists to avoid.
  it('moves its live reading while the ledger keeps what was read at the act', async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'promote', idempotencyKey: 'promote-1' });
    served = 'commit-at-the-act';
    await postAccount(w, 'promote-1', { account: 'deployed' });
    served = 'commit-somebody-else-pushed';

    const body = await state(w);

    expect(body.attempts[0]?.identity).toBe('commit-at-the-act');
    expect(body.live?.identity).toBe('commit-somebody-else-pushed');
  });

  // cm:guard criterion 23. `holding` alone would tell an operator to look without saying at what.
  it('reports a run past a bound as holding, and names the bound it passed', async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'promote', idempotencyKey: 'promote-1' });
    await harness.db.execute(sql`
      UPDATE release_attempts SET started_at = now() - interval '4 hours' WHERE run_id = ${w.runId}
    `);

    const body = await state(w);

    expect(body.bounds.holding).toBe(true);
    expect(body.bounds.crossedNames).toEqual(['total', 'stall']);
  });

  // cm:guard criterion 24. A run that has stopped being a release in progress does not get to do
  // more; the way out is the state route and then finish or abort, which the refusal names.
  it('refuses a further attempt on a holding run, naming the way out', async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'promote', idempotencyKey: 'promote-1' });
    await harness.db.execute(sql`
      UPDATE release_attempts SET started_at = now() - interval '4 hours' WHERE run_id = ${w.runId}
    `);

    const res = await openAttempt(w, { stage: 'deploy', idempotencyKey: 'deploy-1' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('RELEASE_RUN_HOLDING');
    expect(body.message).toContain('.../state');
  });

  // cm:guard the ACCOUNT is still admitted on a holding run. An agent already mid-act must be able
  // to say what happened, or a holding run's last act is the one nothing is recorded about.
  it('still accepts the account of an act already in flight on a holding run', async () => {
    const w = await seed();
    await openAttempt(w, { stage: 'promote', idempotencyKey: 'promote-1' });
    await harness.db.execute(sql`
      UPDATE release_attempts SET started_at = now() - interval '4 hours' WHERE run_id = ${w.runId}
    `);

    const res = await postAccount(w, 'promote-1', { account: 'the deploy hung, I am stopping' });

    expect(res.status).toBe(200);
    const [row] = await rows(w.runId);
    expect(row?.account).toBe('the deploy hung, I am stopping');
  });
});

describe('a release run says what method it is working from', () => {
  const announce = (w: World, body: Record<string, unknown>) =>
    call(`${base(w)}/method`, w.token, { method: 'POST', body: JSON.stringify(body) });

  const finish = (w: World) => call(`${base(w)}/finish`, w.token, { method: 'POST', body: '{}' });

  async function seedJob(w: World, skillName: string): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, type, status, payload, pipeline_run_id, created_by)
      VALUES (${randomUUID()}, ${w.projectId}, 'release_batch', 'queued',
              ${JSON.stringify({ skillName })}::jsonb, ${w.runId}, ${w.userId})
    `);
  }

  // cm:guard the announcement must MERGE into the run metadata. `loadReleaseBatchContext`
  // reconstructs the whole batch from `gateStatus`, `issueIds` and `commitBefore` on that same
  // map, so a whole-object write here empties the batch of everything but its method.
  it('keeps the batch metadata it was announced beside', async () => {
    const w = await seed();
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET metadata = metadata || ${JSON.stringify({ gateStatus: 'awaiting_release' })}::jsonb
      WHERE id = ${w.runId}
    `);

    await announce(w, { skill: 'release-flow', loaded: true });

    const [run] = await harness.db.execute(sql`
      SELECT metadata FROM pipeline_runs WHERE id = ${w.runId}
    `);
    expect(run?.metadata).toMatchObject({
      source: 'release-batch',
      gateStatus: 'awaiting_release',
      method: { skill: 'release-flow', loaded: true },
    });
  });

  // cm:guard criteria 26 and 27 together. A refusal that did not carry the call that clears it
  // would strand every run cut before this deployed — the whole deploy coupling this change
  // declared rests on the way out being in the error.
  it('refuses a finish on a run that announced nothing, and carries the call that clears it', async () => {
    const w = await seed();
    await seedJob(w, 'release-flow');

    const res = await finish(w);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('RELEASE_METHOD_NOT_ANNOUNCED');
    expect(body.message).toContain('/method');
    expect(body.message).toContain('"skill":"release-flow"');
  });

  // cm:guard criterion 28. A run working from a method nobody chose for it is not one finish can
  // close, and the expected skill is read off the RUN'S OWN JOB so a run cut last week is judged
  // against what it was actually asked to run.
  it('refuses a finish whose announcement names another skill than its job', async () => {
    const w = await seed();
    await seedJob(w, 'release-flow');
    await announce(w, { skill: 'issue-flow', loaded: true });

    const res = await finish(w);

    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'RELEASE_METHOD_MISMATCH',
    });
  });

  it('admits a finish once the run announces the skill its job names', async () => {
    const w = await seed();
    await seedJob(w, 'release-flow');
    served = 'commit-after';
    await announce(w, { skill: 'release-flow', loaded: true });

    const res = await finish(w);

    expect(res.status).toBe(200);
  });

  // cm:guard criterion 29, and the amnesty it belongs to. `release-flow` does not exist until
  // forge-plugin ISS-1521 ships it, so a run that could not load it is RECORDED and readable
  // rather than blocked; the refusal is one predicate away.
  // cm:hack ISS-1042 until:forge-plugin ISS-1521 ships plugin/skills/release-flow
  it('reads a run that could not load its method as one that ran without one', async () => {
    const w = await seed();
    await seedJob(w, 'release-flow');
    await announce(w, {
      skill: 'release-flow',
      loaded: false,
      detail: 'no such skill on this box',
    });

    const body = await state(w);

    expect(body.methodUnloaded).toBe(true);
    expect(body.method).toMatchObject({ loaded: false, detail: 'no such skill on this box' });
  });
});
