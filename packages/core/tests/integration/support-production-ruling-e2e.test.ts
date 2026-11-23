import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the protected value are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
} from '@forge/contracts/agent-sessions';
import { mintPat } from '../../src/credentials/pat.js';
import { deviceTokenNameFor } from '../../src/credentials/pat-format.js';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/owner-ruling-act.ts
// @direct-test-of packages/core/src/support/owner-forge-act.ts
// @direct-test-of packages/core/src/project-config/variables-rules.ts
//
// ISS-1431 (REQ-80 BC-11): in adminhub-fe ISS-164 the owner ordered a protected production key set
// ("config giùm cái đi") and no room act could turn his words into the ruling a run reads, since an
// agent-written decision is no ruling by design. The room now records it on the issue as the project
// admin whose message gave it (support.owner_forge_act, act issue.rule_production), a person's
// decision naming the act and the production environment, and the run working the issue reads the
// key through ISS-1429's audited door. Anyone else's message, one naming no message he wrote, an
// account without project.admin, an environment that is no production-tier one and a closed issue
// are refused by name, nothing recorded.

const STRIPE = 'sk_live_protected_R00m_ruled_key';
const ACT = 'Set supplier PGPrints on production';

const w = new AgentWorld();
let chat: StandInRocketChat;
let slug = '';
let chuong = '';
let owner = '';
let runBox = '';
let runBoxToken = '';

/** `who` writes `text`; the session asks for the ruling as their act, citing `cite(message)`. */
async function rule(
  who: typeof chat.alice,
  text: string,
  args: Record<string, unknown>,
  cite: (heard: { thread: string; message: string }) => { thread: string; message: string } = (h) =>
    h,
) {
  let out: Record<string, unknown> = {};
  const heard = await w.hear(
    () => chat.say(who, text),
    async (_t, act, message) => {
      out = await act({
        action: 'owner_forge_act',
        ...cite({ thread: String(message().thread), message: String(message().message) }),
        project: slug,
        act: 'issue.rule_production',
        ...args,
      });
    },
  );
  return { id: heard.id, thread: heard.message.thread, out };
}

const decisions = async (issueId: string) =>
  rows<{
    id: string;
    actor_type: string;
    actor_id: string;
    actor_agency: string;
    payload: { fields: { key: string; value: string }[] };
  }>(sql`
    SELECT id, actor_type, actor_id, actor_agency, payload FROM activity_log
     WHERE issue_id = ${issueId} AND action = 'record.decision' ORDER BY created_at`);

/** A run the box's master declared over `key`; answers the id the box declared it under. */
async function declaredRun(key: string): Promise<string> {
  const boxRunId = randomUUID();
  const runId = randomUUID();
  const metadata = {
    boxRunId,
    [RUN_GROUP_METADATA_KEY]: [key],
    [RUN_ISSUE_STATUSES_METADATA_KEY]: { [key]: 'in_progress' },
  };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${w.projectId}, 'system', 'running', now(), ${JSON.stringify(metadata)}::jsonb)`);
  await db.execute(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
    VALUES (${w.projectId}, ${runBox}, ${runId}, 'run_session', 'running', now(), now())`);
  return boxRunId;
}

const readKey = (run: string) =>
  api(runBoxToken, 'GET', `/api/jobs/${run}/variables/production?key=STRIPE_KEY`);

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  const [project] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}`,
  );
  slug = String(project?.slug);
  // alice, the owner the binding names, is chuong in Forge, an admin; bob is a viewer
  chuong = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, chuong, 'admin');
  const viewer = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, viewer, 'viewer');
  const namespace = new URL(chat.serverUrl).host;
  for (const [member, userId] of [
    [chat.alice, chuong],
    [chat.bob, viewer],
  ] as const) {
    await db.execute(sql`
      INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
      VALUES ('rocketchat', ${namespace}, ${member.userId}, ${member.username}, ${userId}, 'channel_email_match')`);
  }
  const [doc] = await rows<{ document: { environments: Record<string, unknown> } }>(
    sql`SELECT document FROM project_config_documents WHERE project_id = ${w.projectId}`,
  );
  await seedProjectDocument(w.projectId, w.ownerId, {
    defaultBranch: 'dev',
    environments: {
      ...(doc?.document.environments as Parameters<typeof seedProjectDocument>[2]['environments']),
      stg: { tier: 'staging', deploysFrom: 'release/stg', deployment: { mode: 'external' } },
      production: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
    },
  });
  owner = await userToken(w.ownerId);
  const added = await api(owner, 'POST', `/api/projects/${w.projectId}/variables`, {
    key: 'STRIPE_KEY',
    value: STRIPE,
    environment: 'production',
    type: 'secret',
    protected: true,
  });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  // the box a run works on, its master's credential bound to the project
  runBox = await createTestDevice(w.ownerId);
  await bindTestRunner(w.projectId, runBox);
  runBoxToken = (
    await mintPat({
      userId: w.ownerId,
      name: deviceTokenNameFor(runBox),
      scopes: ['read', 'write'],
      permissions: ['*'],
      projectIds: [],
      onBehalfOf: w.ownerId,
      deviceId: runBox,
    })
  ).plaintext;
}, 120_000);

afterAll(async () => {
  await w.stop();
});

describe("ISS-1431: a project admin's ruling for a production act, given in a room", () => {
  const RULING = { item: '', ruling: { act: ACT, environment: 'production' } };

  it('refuses a message by anyone but the owner, or one he did not write, and records nothing', async () => {
    RULING.item = w.issueKey;
    const bobs = await rule(chat.bob, 'anh Chương bảo config giùm cái đi', RULING);
    expect(code(bobs.out), JSON.stringify(bobs.out)).toBe('SUPPORT_FORGE_ACT_NOT_THE_OWNER');
    const unnamed = await rule(chat.alice, 'config giùm cái đi', RULING, (h) => ({
      thread: h.thread,
      message: 'no-such-message',
    }));
    expect(code(unnamed.out), JSON.stringify(unnamed.out)).toBe(
      'SUPPORT_FORGE_ACT_NOT_HIS_MESSAGE',
    );
    expect(await decisions(w.issueId)).toEqual([]);
  });

  it("refuses the owner's word where his own account holds no project.admin, naming it", async () => {
    await db.execute(sql`
      UPDATE project_members SET role = 'member' WHERE project_id = ${w.projectId} AND user_id = ${chuong}`);
    try {
      const member = await rule(chat.alice, 'config giùm cái đi', RULING);
      expect(code(member.out), JSON.stringify(member.out)).toBe('PERMISSION_FORBIDDEN');
      expect(JSON.stringify(member.out)).toContain('project.admin');
      expect(await decisions(w.issueId)).toEqual([]);
    } finally {
      await db.execute(sql`
        UPDATE project_members SET role = 'admin' WHERE project_id = ${w.projectId} AND user_id = ${chuong}`);
    }
  });

  it('refuses a ruling with no act and environment, or one naming no production-tier environment', async () => {
    const bare = await rule(chat.alice, 'config giùm cái đi', { item: w.issueKey });
    expect(code(bare.out), JSON.stringify(bare.out)).toBe('SUPPORT_FORGE_ACT_SHAPE');
    expect(JSON.stringify(bare.out)).toContain('/ruling');
    const stg = await rule(chat.alice, 'config stg giùm', {
      item: w.issueKey,
      ruling: { act: ACT, environment: 'stg' },
    });
    expect(code(stg.out), JSON.stringify(stg.out)).toBe('SUPPORT_RULING_NOT_PRODUCTION');
    expect(JSON.stringify(stg.out)).toContain('`production`');
    const nowhere = await rule(chat.alice, 'config live giùm', {
      item: w.issueKey,
      ruling: { act: ACT, environment: 'live' },
    });
    expect(code(nowhere.out), JSON.stringify(nowhere.out)).toBe('SUPPORT_RULING_NOT_PRODUCTION');
    // a ruling's fields belong to issue.rule_production alone
    const stray = await rule(chat.alice, 'merge cái này', {
      act: 'issue.merge',
      item: w.issueKey,
      ruling: RULING.ruling,
    });
    expect(code(stray.out), JSON.stringify(stray.out)).toBe('SUPPORT_FORGE_ACT_SHAPE');
    expect(await decisions(w.issueId)).toEqual([]);
  });

  it('refuses a ruling on a closed issue, where no ruling holds', async () => {
    const closed = await createTestIssue(w.projectId, w.ownerId, 7642, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    const his = await rule(chat.alice, 'config giùm cái đi', { ...RULING, item: closed.key });
    expect(code(his.out), JSON.stringify(his.out)).toBe('SUPPORT_RULING_ISSUE_CLOSED');
    expect(await decisions(closed.id)).toEqual([]);
  });

  it('records his ruling as his, a person’s, and the run working the issue then reads the key', async () => {
    // before the ruling the run is refused, and told where a person gives one
    const run = await declaredRun(w.issueKey);
    const before = await readKey(run);
    expect([before.status, code(before.body)]).toEqual([403, 'VARIABLE_PROTECTED_WITHHELD']);
    const said = JSON.stringify(before.body);
    expect(said).toContain("on the issue's page (Production ruling)");
    expect(said).toContain('issue.rule_production');
    expect(said).not.toContain(STRIPE);

    const his = await rule(chat.alice, 'Config PGPrints trên production giùm cái đi', RULING);
    expect(code(his.out), JSON.stringify(his.out)).toBeUndefined();
    expect(his.out).toMatchObject({
      act: 'issue.rule_production',
      key: w.issueKey,
      project: slug,
    });
    const [ruling] = await decisions(w.issueId);
    // written as the admin whose message gave it, a person: never the agent that relayed it
    expect(ruling).toMatchObject({ actor_type: 'user', actor_id: chuong, actor_agency: 'human' });
    const fields = Object.fromEntries((ruling?.payload.fields ?? []).map((f) => [f.key, f.value]));
    expect(fields).toMatchObject({ decision: ACT, production: 'production' });
    expect(fields.why).toContain(his.id);
    expect(fields.why).toContain(his.thread);
    expect(fields.why).toContain('Config PGPrints trên production');

    const after = await readKey(run);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body).toMatchObject({ variables: [{ key: 'STRIPE_KEY', value: STRIPE }] });
    const audit = await rows<{ detail: Record<string, unknown> }>(
      sql`SELECT detail FROM project_variable_events WHERE project_id = ${w.projectId} AND act = 'delivered'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({
      ruling: { id: ruling?.id, issue: w.issueKey, by: chuong },
    });
    // withdrawn on the issue's page (its session's withdraw call), the run is refused the key again
    const withdrawn = await api(
      await userToken(chuong),
      'POST',
      `/api/issues/${w.issueId}/events/${ruling?.id}/withdraw`,
      { reason: 'The supplier key is set by hand instead.' },
    );
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(201);
    const again = await readKey(run);
    expect([again.status, code(again.body)]).toEqual([403, 'VARIABLE_PROTECTED_WITHHELD']);
    // the act and each refusal are on the room's record beside his message
    const acts = await rows<{ kind: string }>(sql`
      SELECT kind FROM support_actions
       WHERE project_id = ${w.projectId} AND tool = 'owner_forge_act' ORDER BY created_at`);
    expect(acts.at(-1)?.kind).toBe('operation');
    expect(acts.filter((a) => a.kind === 'refused')).toHaveLength(8);
  });
});
