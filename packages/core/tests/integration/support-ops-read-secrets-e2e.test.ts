import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { createTestIssue, rows } from '../helpers/factories.js';
import { refusalCodes, SupportWorld } from '../helpers/support-world.js';

/**
 * @direct-test-of packages/core/src/support/ops-read.ts
 * @direct-test-of packages/core/src/runners/box-acts.ts
 * @direct-test-of packages/core/src/support/declared-read.ts
 * @direct-test-of packages/core/src/support/run-reads.ts
 */

const TOKEN = 'fo_live_4f1c9e7a2b';
const EPOD_LOGS = {
  name: 'epod-logs',
  summary: "Search one day's ePOD production log for a fixed string",
  argv: ['repo:scripts/ops/epod-logs'],
  params: [
    {
      name: 'text',
      description: 'the fixed string: an order id or an exception class',
      required: true,
      pattern: '[A-Za-z0-9_][A-Za-z0-9_-]{0,39}',
      maxLength: 40,
    },
  ],
  secrets: [{ env: 'FORGE_OPS_TOKEN', secret: 'secret://ops/forge-ops-token' }],
};

const w = new SupportWorld();
let roomId = '';

/** A member asks in the group and the session makes one `forge_support` call for it. */
async function sessionDoes(
  args: Record<string, unknown>,
): Promise<{ thread: string; out: Record<string, unknown> }> {
  await w.settleWarm();
  let out: Record<string, unknown> | null = null;
  let armed = true;
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from === 'forge' || !armed) continue;
      armed = false;
      out = await act({ ...args, thread: m.thread });
    }
  };
  const thread = await w.chat.say(w.chat.bob, 'Can you look at this?');
  await expect.poll(() => out, { timeout: 15_000 }).not.toBeNull();
  return { thread, out: out as unknown as Record<string, unknown> };
}

/** The `ops.read` frames the box was asked, newest last. */
const reads = () => w.box.acts.filter((a) => a.event === 'ops.read');

beforeAll(async () => {
  await w.start();
  await w.bindTarget({
    rids: [w.chat.rid],
    agent: {
      product: 'ePOD, proof of delivery',
      readers: 'team',
      grants: { abilities: ['ops_reads'], reads: [EPOD_LOGS] },
    },
  });
  roomId = String((await w.rooms())[0]?.id);
}, 120_000);

afterAll(() => w.stop());

// ISS-707: a project's production reads ran only on the box holding a hand-placed credential. A read
// is now code in the project's repo (`repo:<path>`, run from the box's checkout of the project) and
// its credential a project secret, which core hands the box for that one process and cuts from what
// the read printed; a secret the vault does not hold refuses the read by name, before the box is asked.
describe("ISS-707: a read is the project repo's code, and its credential a project secret", () => {
  it('refuses SUPPORT_READ_SECRET_MISSING where the secret is not set, and asks nothing of the box', async () => {
    const before = reads().length;
    const { out } = await sessionDoes({
      action: 'read',
      name: 'epod-logs',
      args: { text: 'ORD1' },
    });
    // [READ_SECRET_UNDECLARABLE] before the fix: the grant refused `secrets`, so the credential stayed on one box
    expect(refusalCodes(out), JSON.stringify(out)).toEqual(['SUPPORT_READ_SECRET_MISSING']);
    expect(JSON.stringify(out)).toContain('the project secret ops/forge-ops-token');
    expect(reads().length).toBe(before);
  });

  it('hands the box the program in the checkout and the secret for that process, and cuts it from the answer', async () => {
    const set = await api(
      w.owner,
      'PUT',
      `/api/projects/${w.projectId}/secrets/ops/forge-ops-token`,
      {
        value: TOKEN,
      },
    );
    expect(set.status, JSON.stringify(set.body)).toBeLessThan(300);
    w.box.readAnswer = () => ({ exitCode: 0, stdout: `ORD1 found; auth ${TOKEN}\n`, stderr: '' });
    const { thread, out } = await sessionDoes({
      action: 'read',
      name: 'epod-logs',
      args: { text: 'ORD1' },
    });
    expect(out, JSON.stringify(out)).toMatchObject({
      name: 'epod-logs',
      exitCode: 0,
      isError: false,
    });
    expect(reads().at(-1)?.data).toMatchObject({
      argv: ['repo:scripts/ops/epod-logs', 'ORD1'],
      env: { FORGE_OPS_TOKEN: TOKEN },
    });
    expect(String(out.stdout)).toContain('ORD1 found; auth [secret FORGE_OPS_TOKEN]');
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const recorded = (await w.actions(roomId)).filter(
      (a) => a.kind === 'diagnose' && a.tool === 'read' && a.thread === thread,
    );
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded)).not.toContain(TOKEN);
    w.box.readAnswer = (d) => ({ exitCode: 0, stdout: `read ${JSON.stringify(d.argv)}` });
  });
});

// ISS-707: a pipeline run read production only through the credential its box held. It now runs the
// project's declared read by the same path a room does, and the read is kept on the run's issue: who
// (the run, its token's holder), which read, its arguments, its exit and its output, cut and scrubbed.
describe('ISS-707: a pipeline run takes the same declared read, audited on its issue by run', () => {
  it('runs a declared read for a live run of the project, records it on the issue, and refuses the rest by name', async () => {
    const [member] = await rows<{ user_id: string }>(
      sql`SELECT user_id FROM project_members WHERE project_id = ${w.projectId} AND role = 'owner' LIMIT 1`,
    );
    const issue = await createTestIssue(w.projectId, String(member?.user_id), 901, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const runId = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${w.projectId}, ${issue.id}, 'issue', 'running', now())`);
    const set = await api(
      w.owner,
      'PUT',
      `/api/projects/${w.projectId}/secrets/ops/forge-ops-token`,
      {
        value: TOKEN,
      },
    );
    expect(set.status, JSON.stringify(set.body)).toBeLessThan(300);
    w.box.readAnswer = () => ({ exitCode: 0, stdout: `ORD9 seen; auth ${TOKEN}\n`, stderr: '' });
    const path = `/api/projects/${w.projectId}/ops-reads/epod-logs`;
    const got = await api(w.owner, 'POST', path, { run: runId, args: { text: 'ORD9' } });
    // [RUN_READ_DOORLESS] before the fix: a run had no door to a declared read, so it used its box's credential
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.read).toMatchObject({ name: 'epod-logs', exitCode: 0 });
    expect(reads().at(-1)?.data).toMatchObject({
      argv: ['repo:scripts/ops/epod-logs', 'ORD9'],
      env: { FORGE_OPS_TOKEN: TOKEN },
    });
    expect(JSON.stringify(got.body)).not.toContain(TOKEN);
    const audit = await rows<{ action: string; payload: Record<string, unknown> }>(
      sql`SELECT action, payload FROM activity_log WHERE issue_id = ${issue.id} AND action = 'ops.read'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({
      run: runId,
      name: 'epod-logs',
      args: { text: 'ORD9' },
      exitCode: 0,
      stdout: 'ORD9 seen; auth [secret FORGE_OPS_TOKEN]\n',
    });
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    const unknown = await api(w.owner, 'POST', path, { run: randomUUID(), args: { text: 'ORD9' } });
    expect(unknown.body).toMatchObject({ code: 'PIPELINE_RUN_NOT_FOUND' });
    const undeclared = await api(
      w.owner,
      'POST',
      `/api/projects/${w.projectId}/ops-reads/hub-logs`,
      {
        run: runId,
      },
    );
    expect(undeclared.body).toMatchObject({ code: 'SUPPORT_READ_UNDECLARED' });
    w.box.readAnswer = (d) => ({ exitCode: 0, stdout: `read ${JSON.stringify(d.argv)}` });
  });
});
