import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the forge-ops credential is a project secret, sealed in the integration vault (ISS-707)
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { closeOrphanedScriptFires } from '../../src/schedules/fires.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';
import { boxToken, type Served, serveCore, stopCore } from '../helpers/preview-world.js';
import { SessionBox, SUPPORT_BOX_CAPS } from '../helpers/support-session-box.js';

/**
 * @direct-test-of packages/core/src/schedules/script-dispatch.ts
 * @direct-test-of packages/core/src/schedules/script-ops.ts
 * @direct-test-of packages/core/src/schedules/script-feedback.ts
 * @direct-test-of packages/core/src/schedules/service.ts
 * @direct-test-of packages/core/src/schedules/fires.ts
 * @direct-test-of packages/core/src/feedback/signal-filing.ts
 * @direct-test-of packages/core/src/automation/facts.ts
 * @direct-test-of packages/core/src/execution-ports.ts
 */

// REQ-87 end to end on a real database, with core served and a stand-in box bound to the project: a
// script schedule declares read-only calls on its project's forge-ops target, the save refuses one
// that is not read-only by name, the box runs only what is declared, a breach seen on two firings in
// a row becomes one feedback item filed as the project's own agent and seen on the schedule, and each
// firing's calls, filings and state are on its run history. No agent session runs.

type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>) => [...(await db.execute(q))] as Row[];

let core: Served;
let box: SessionBox;
let projectId = '';
let owner = '';
/** What the stand-in status read answers; a test plants a breach here. */
let status = '';

const healthy = 'orders flowing';
const stuck = 'orders stuck';

/** A one-call declaration on the project's forge-ops target, its credential a project secret. */
const OPS = {
  program: '/home/dev/.local/bin/forge-ops',
  secrets: [{ env: 'FORGE_OPS_TOKEN', secret: 'secret://ops/forge-ops-token' }],
  calls: [{ name: 'status', tool: 'status', args: { target: 'app-production' } }],
};

/** A check that files one item for a breach seen on two firings in a row, and resets on recovery. */
const CONFIRM_TWICE = `const out = await ctx.ops.status();
const signal = 'app:orders';
const streak = ctx.state.get().streak ?? {};
const next = /stuck/.test(out.stdout) ? { [signal]: (streak[signal] ?? 0) + 1 } : {};
if (next[signal] === 2) await ctx.feedback.file({ kind: 'bug', title: 'Orders stuck', body: out.stdout, signalKey: signal });
ctx.state.set({ streak: next });`;

const opsReads = () => box.acts.filter((a) => a.event === 'ops.read');

beforeAll(async () => {
  const o = await createTestUser({ verified: true });
  projectId = (await createTestProject(o.id)).id;
  await addProjectMember(projectId, o.id, 'owner');
  owner = await userToken(o.id);
  core = await serveCore();
  const deviceId = await createTestDevice(o.id);
  await bindTestRunner(projectId, deviceId);
  await db.execute(sql`UPDATE runners SET last_seen_at = now() WHERE device_id = ${deviceId}`);
  await db.execute(
    sql`UPDATE devices SET capabilities = ${SUPPORT_BOX_CAPS}::jsonb WHERE id = ${deviceId}`,
  );
  // the forge-ops credential the declaration names, set as that project secret (ISS-707)
  const cred = await api(owner, 'PUT', `/api/projects/${projectId}/secrets/ops/forge-ops-token`, {
    value: 'fo_watch_token',
  });
  expect(cred.status, JSON.stringify(cred.body)).toBeLessThan(300);
  box = new SessionBox(core.base, await boxToken(o.id, deviceId), deviceId);
  // the forge-ops CLI on the box, as it would print the status read
  box.readAnswer = () => ({
    exitCode: 0,
    stdout: status,
    stderr: '',
    truncated: false,
    timedOut: false,
    durationMs: 5,
  });
  await box.connect();
}, 120_000);

afterAll(async () => {
  box?.control?.close();
  if (core) await stopCore(core);
});

const create = (body: Body) =>
  api(owner, 'POST', '/api/schedules', {
    projectId,
    cron: '*/15 * * * *',
    kind: 'script',
    enabled: false,
    ...body,
  });

const fireOf = async (scheduleId: string) => {
  const [fire] = await rows(sql`
    SELECT id, status, error, refusal, output, session_id, ops_calls, filings, state_after
      FROM schedule_runs WHERE schedule_id = ${scheduleId} ORDER BY created_at DESC LIMIT 1`);
  if (!fire) throw new Error(`no fire of ${scheduleId}`);
  return fire;
};

describe('a declaration that is not read-only is refused by name when it is saved (BC-1)', () => {
  it.each([
    [
      'deploy',
      { name: 'ship', tool: 'deploy', args: { target: 'app-production' } },
      'forge-ops deploy',
    ],
    [
      'an exec that writes',
      {
        name: 'wipe',
        tool: 'exec_command',
        args: { target: 'app-production', command: 'rm -rf /var/lib/x' },
      },
      '`rm -rf /var/lib/x`, which is not read-only',
    ],
  ])('refuses %s, naming the call, and saves nothing', async (_, call, said) => {
    const res = await create({
      name: `refused ${call.name}`,
      script: 'return 1;',
      ops: { ...OPS, calls: [call] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusals = (
      res.body.error as { refusals: { code: string; path: string; detail: string }[] }
    ).refusals;
    expect(refusals).toEqual([
      expect.objectContaining({ code: 'SCRIPT_OPS_NOT_READ_ONLY', path: '/ops/calls/0' }),
    ]);
    expect(refusals[0]?.detail).toContain(said);
    const kept = await rows(sql`SELECT id FROM schedules WHERE name = ${`refused ${call.name}`}`);
    expect(kept).toEqual([]);
  });

  it('refuses ops on a schedule that is not a script', async () => {
    const res = await api(owner, 'POST', '/api/schedules', {
      projectId,
      name: 'prompt with ops',
      cron: '0 9 * * *',
      prompt: 'say hi',
      ops: OPS,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.detail)).toContain('ops must be omitted when kind is "prompt"');
  });
});

describe('a script calls only what its schedule declares (BC-1)', () => {
  it('refuses an undeclared call by name on the record, with nothing asked of the box', async () => {
    const made = await create({
      name: 'undeclared',
      script: `try { await ctx.ops.deploy(); } catch (e) { ctx.log(e.code, e.message); }
               const s = await ctx.ops.status(); ctx.log(s.stdout);`,
      ops: OPS,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const before = opsReads().length;
    const ran = await api(owner, 'POST', `/api/schedules/${String(made.body.id)}/run`);
    expect(ran.status, JSON.stringify(ran.body)).toBe(202);
    const fire = await fireOf(String(made.body.id));
    expect(fire.status).toBe('success');
    expect(fire.session_id).toBeNull();
    expect(String(fire.output)).toContain(
      'SCRIPT_OPS_UNDECLARED SCRIPT_OPS_UNDECLARED: ctx.ops.deploy is not declared on this schedule; it declares status',
    );
    expect(fire.ops_calls).toEqual([
      { name: 'deploy', outcome: 'refused', code: 'SCRIPT_OPS_UNDECLARED' },
      { name: 'status', outcome: 'answered', exitCode: 0, durationMs: 5 },
    ]);
    // only the declared call reached the box, as the CLI with its fixed arguments
    expect(
      opsReads()
        .slice(before)
        .map((a) => a.data.argv),
    ).toEqual([[OPS.program, 'status', '{"target":"app-production"}']]);
  });

  it('fails a firing whose stored declaration stopped reading, before the script runs', async () => {
    const made = await create({
      name: 'stopped reading',
      script: `ctx.log('the script ran'); await ctx.ops.status();`,
      ops: OPS,
    });
    const id = String(made.body.id);
    await db.execute(sql`
      UPDATE schedules SET ops = ${JSON.stringify({
        ...OPS,
        calls: [{ name: 'status', tool: 'deploy', args: { target: 'app-production' } }],
      })}::jsonb WHERE id = ${id}`);
    const before = opsReads().length;
    const ran = await api(owner, 'POST', `/api/schedules/${id}/run`);
    expect(ran.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(ran.body)).toContain('SCRIPT_OPS_NOT_READ_ONLY');
    const fire = await fireOf(id);
    expect(fire).toMatchObject({
      status: 'failed',
      refusal: 'SCRIPT_OPS_NOT_READ_ONLY',
      output: null,
    });
    expect(opsReads().length).toBe(before);
  });
});

describe('a check confirmed twice, every 15 minutes with no agent session (BC-2..BC-5)', () => {
  let id = '';
  let agentId = '';
  const fire = async (planted: string) => {
    status = planted;
    const ran = await api(owner, 'POST', `/api/schedules/${id}/run`);
    expect(ran.status, JSON.stringify(ran.body)).toBe(202);
    return fireOf(id);
  };
  const items = () =>
    rows(sql`
      SELECT f.id, f.fb_seq, f.signal_key, f.reported_by, f.reporter_agency, f.where_seen, f.kind,
             (SELECT count(*)::int FROM feedback_occurrences o WHERE o.feedback_id = f.id) AS occurrences
        FROM feedback f WHERE f.project_id = ${projectId} ORDER BY f.fb_seq`);

  beforeAll(async () => {
    const made = await create({
      name: 'orders check',
      script: CONFIRM_TWICE,
      ops: OPS,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    id = String(made.body.id);
  });

  it('reads healthy, files nothing, and records each call and the state it left', async () => {
    const f = await fire(healthy);
    expect(f.status, String(f.error)).toBe('success');
    expect(f.session_id).toBeNull();
    expect(
      (f.ops_calls as { name: string; outcome: string }[]).map((c) => [c.name, c.outcome]),
    ).toEqual([['status', 'answered']]);
    expect(f.filings).toEqual([]);
    expect(f.state_after).toEqual({ streak: {} });
    expect(await items()).toEqual([]);
  });

  it('files nothing for a single-run blip', async () => {
    expect((await fire(stuck)).state_after).toEqual({ streak: { 'app:orders': 1 } });
    expect((await fire(healthy)).state_after).toEqual({ streak: {} });
    expect(await items()).toEqual([]);
  });

  it('files one item for a breach seen twice, as the project agent, seen on the schedule', async () => {
    expect((await fire(stuck)).filings).toEqual([]);
    const second = await fire(stuck);
    expect(second.filings).toEqual([{ signalKey: 'app:orders', key: 'FB-1', created: true }]);
    const [item, ...more] = await items();
    expect(more).toEqual([]);
    expect(item).toMatchObject({
      fb_seq: 1,
      signal_key: 'app:orders',
      reporter_agency: 'agent',
      where_seen: 'schedule orders check',
      kind: 'bug',
      occurrences: 1,
    });
    agentId = String(item?.reported_by);
    const [agent] = await rows(sql`SELECT kind FROM users WHERE id = ${agentId}`);
    expect(agent?.kind).toBe('agent');
  });

  it('files nothing more while the breach lasts, nor once it recovers', async () => {
    expect((await fire(stuck)).filings).toEqual([]);
    const recovered = await fire(healthy);
    expect(recovered.filings).toEqual([]);
    expect(recovered.state_after).toEqual({ streak: {} });
    expect((await items()).length).toBe(1);
  });

  it('joins the open item when the same breach is confirmed again, never filing a twin (BC-2)', async () => {
    await fire(stuck);
    const again = await fire(stuck);
    expect(again.filings).toEqual([{ signalKey: 'app:orders', key: 'FB-1', created: false }]);
    const all = await items();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ occurrences: 2, reported_by: agentId });
  });

  it('shows the calls and filings on the fire the run history reads (BC-4)', async () => {
    const f = await fireOf(id);
    const res = await api(
      owner,
      'GET',
      `/api/projects/${projectId}/automation/fires/${String(f.id)}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const shown = res.body.fire as Body;
    expect(shown.opsCalls).toEqual(f.ops_calls);
    expect(shown.filings).toEqual([{ signalKey: 'app:orders', key: 'FB-1', created: false }]);
    expect(shown.stateAfter).toEqual({ streak: { 'app:orders': 2 } });
    expect(shown.sessionId).toBeNull();
  });
});

// ISS-1130: epod's manual fire 90324d91 sat `running` from 18:13Z, its POST /run answered 502 by a core
// restart, and nothing would ever settle it
describe('a script fire a core restart orphaned is closed by name, never left running', () => {
  it('fails a sessionless script fire running past any live firing, and leaves a fresh one running', async () => {
    const made = await create({ name: 'orphan watch', script: 'return 1;' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const scheduleId = String(made.body.id);
    const open = async (minutesAgo: number) => {
      const [r] = await rows(sql`
        INSERT INTO schedule_runs (schedule_id, project_id, trigger, status, started_at)
        VALUES (${scheduleId}, ${projectId}, 'manual', 'running', now() - make_interval(mins => ${minutesAgo}))
        RETURNING id`);
      return String(r?.id);
    };
    const orphan = await open(11);
    const fresh = await open(2);
    const closed = await closeOrphanedScriptFires(new Date());
    expect(closed).toContain(orphan);
    expect(closed).not.toContain(fresh);
    const [o] = await rows(
      sql`SELECT status, error, finished_at FROM schedule_runs WHERE id = ${orphan}`,
    );
    expect(o?.status).toBe('failed');
    expect(String(o?.error)).toContain('a restart');
    expect(o?.finished_at).not.toBeNull();
    const [f] = await rows(sql`SELECT status FROM schedule_runs WHERE id = ${fresh}`);
    expect(f?.status).toBe('running');
  });
});

// ISS-707: a script's forge-ops calls ran under whatever credential the box's own forge-ops held. The
// declaration now names its credential as a project secret, which core reads from the vault and hands
// the box for that one call; an unset secret fails the call by name before the box is asked, and what
// the call printed is cut of it before the script reads it.
describe("ISS-707: a script's ops call takes its credential from a project secret, never the box", () => {
  const CRED = { env: 'FORGE_OPS_TOKEN', secret: 'secret://ops/script-ops-token' };
  const TOKEN = 'fo_sched_9d2c41';
  const call = OPS.calls[0];

  it('refuses at save a declaration that names no credential secret', async () => {
    const res = await create({
      name: 'no credential',
      script: 'return 1;',
      ops: { program: OPS.program, calls: [call] },
    });
    // [SCRIPT_OPS_BOX_CREDENTIAL] before the fix: saved, and run on the box's own credential
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toContain('secrets');
  });

  // the priced amnesty `script-ops-box-credential`: epod's live watch was saved before secrets were asked
  it('runs a stored declaration with no secret on the box credential, warning by name on each call', async () => {
    const made = await create({
      name: 'legacy watch',
      script: `const s = await ctx.ops.status(); ctx.log(s.stdout);`,
      ops: { ...OPS, calls: [call] },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.id);
    await db.execute(sql`
      UPDATE schedules SET ops = ${JSON.stringify({ program: OPS.program, calls: [call] })}::jsonb
       WHERE id = ${id}`);
    const before = opsReads().length;
    expect((await api(owner, 'POST', `/api/schedules/${id}/run`)).status).toBe(202);
    const fire = await fireOf(id);
    // [STORED_NO_SECRET_GOES_DARK] before the fix: the fire failed, and the live watch with it
    expect(fire.status, String(fire.error)).toBe('success');
    expect(fire.ops_calls).toEqual([
      expect.objectContaining({
        name: 'status',
        outcome: 'answered',
        warning: expect.stringContaining('legacy watch declares no secrets'),
      }),
    ]);
    expect(opsReads().length).toBe(before + 1);
    expect(opsReads().at(-1)?.data.env).toBeUndefined();
  });

  it('fails the call by name while the secret is unset, then hands it for that call alone and cuts it', async () => {
    const made = await create({
      name: 'credential',
      script: `try { const s = await ctx.ops.status(); ctx.log(s.stdout); } catch (e) { ctx.log(e.code, e.message); }`,
      ops: { ...OPS, calls: [call], secrets: [CRED] },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.id);
    const before = opsReads().length;
    expect((await api(owner, 'POST', `/api/schedules/${id}/run`)).status).toBe(202);
    const unset = await fireOf(id);
    expect(unset.ops_calls).toEqual([
      { name: 'status', outcome: 'failed', code: 'SCRIPT_OPS_FAILED' },
    ]);
    expect(String(unset.output)).toContain('ops/script-ops-token');
    expect(opsReads().length).toBe(before);
    const set = await api(owner, 'PUT', `/api/projects/${projectId}/secrets/ops/script-ops-token`, {
      value: TOKEN,
    });
    expect(set.status, JSON.stringify(set.body)).toBeLessThan(300);
    const answer = box.readAnswer;
    box.readAnswer = () => ({ exitCode: 0, stdout: `epod-api running as ${TOKEN}`, stderr: '' });
    expect((await api(owner, 'POST', `/api/schedules/${id}/run`)).status).toBe(202);
    const ran = await fireOf(id);
    box.readAnswer = answer;
    expect(opsReads().at(-1)?.data).toMatchObject({ env: { FORGE_OPS_TOKEN: TOKEN } });
    expect(String(ran.output)).toContain('epod-api running as [secret FORGE_OPS_TOKEN]');
    expect(JSON.stringify(ran)).not.toContain(TOKEN);
  });
});
