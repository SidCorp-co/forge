import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { markPendingHumanConfirm } from '../../src/release-batch/coolify-prod-gate.js';
import { addProjectMember, createTestUser, rows } from '../helpers/factories.js';
import { cutAndAsk } from '../helpers/release-approval.js';
import { seedProduction } from '../helpers/release-world.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/owner-archive-act.ts
// @direct-test-of packages/core/src/support/owner-forge-act.ts
// @direct-test-of packages/core/src/project-config/bindings.ts
// @direct-test-of packages/core/src/project-config/unbind-for-archive.ts
//
// ISS-1449 (FB-848): the owner of the Agenfold group ruled in chat to remove the HOP project, and
// owner_forge_act refused project.archive as an act no door from chat makes, so he had to do it on a
// page. The room now archives it as him: only the owner's own message, his account an admin of the
// project's organization; it stops the project's runs, withdraws its open questions, switches off its
// groups and deploy bindings and archives it. It never reaches the project's repository or a deployed
// site: every outbound call this process makes is recorded, and none goes to a deploy target or a git
// host, nothing is queued for a deploy binding, and no row is deleted.

const w = new AgentWorld();
let chat: StandInRocketChat;
let slug = '';
let orgId = '';
let chuong = '';
let prodBinding = '';
const outbound: string[] = [];
const realFetch = globalThis.fetch;

/** `who` writes `text`; the session asks to archive `item` as their act. */
async function archive(who: typeof chat.alice, text: string, item = slug) {
  let out: Record<string, unknown> = {};
  const heard = await w.hear(
    () => chat.say(who, text),
    async (_t, act, message) => {
      out = await act({
        action: 'owner_forge_act',
        thread: String(message().thread),
        message: String(message().message),
        project: slug,
        act: 'project.archive',
        item,
      });
    },
  );
  return { id: heard.id, out };
}

const archivedAt = async () =>
  (
    await rows<{ at: string | null }>(
      sql`SELECT archived_at AS at FROM projects WHERE id = ${w.projectId}`,
    )
  )[0]?.at;
const count = async (table: 'issues' | 'integration_bindings' | 'support_rooms') =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE project_id = ${w.projectId}`,
    )
  )[0]?.n ?? 0;
const activeBindings = async () =>
  (
    await rows<{ provider: string; role: string; active: boolean }>(
      sql`SELECT provider, role, active FROM integration_bindings WHERE project_id = ${w.projectId}`,
    )
  ).filter((b) => b.active);
const queuedForDeploy = async () =>
  (
    await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pgboss_v12.job
       WHERE name = 'forge.integrations' AND data->>'jobKind' = 'coolify.dispatch'`)
  )[0]?.n ?? 0;
const openQuestions = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM agent_questions WHERE project_id = ${w.projectId} AND status = 'open'`,
    )
  )[0]?.n ?? 0;

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  const [project] = await rows<{ slug: string; org: string }>(
    sql`SELECT slug, org_id AS org FROM projects WHERE id = ${w.projectId}`,
  );
  slug = String(project?.slug);
  orgId = String(project?.org);
  // alice, the owner the binding names, is chuong in Forge, an admin of the organization; bob is a viewer
  chuong = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, chuong, 'admin');
  await db.execute(
    sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${chuong}, 'admin')`,
  );
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
  ({ bindingId: prodBinding } = await seedProduction({
    projectId: w.projectId,
    ownerId: w.ownerId,
    probes: 'none',
    trigger: 'on-request',
    others: {
      dev: {
        tier: 'dev',
        deploysFrom: 'dev',
        deployment: { binding: w.devTarget, trigger: 'on-request' },
      },
    },
  }));
  // every call out of this process, recorded and let through
  vi.stubGlobal('fetch', async (input: URL | string | Request, init?: RequestInit) => {
    outbound.push(input instanceof Request ? input.url : String(input));
    return realFetch(input, init);
  });
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await w.stop();
});

describe("ISS-1449: the owner's ruling to archive a project, given in his room", () => {
  it('refuses a message by anyone but the owner, and archives nothing', async () => {
    const bobs = await archive(chat.bob, 'archive the project');
    expect(code(bobs.out), JSON.stringify(bobs.out)).toBe('SUPPORT_FORGE_ACT_NOT_THE_OWNER');
    expect(await archivedAt()).toBeNull();
    expect((await activeBindings()).length).toBeGreaterThan(0);
  });

  it("refuses the owner's word where his account does not admin the organization, naming it", async () => {
    await db.execute(
      sql`UPDATE organization_members SET role = 'member' WHERE org_id = ${orgId} AND user_id = ${chuong}`,
    );
    try {
      const member = await archive(chat.alice, 'archive it');
      expect(code(member.out), JSON.stringify(member.out)).toMatch(/FORBIDDEN|PERMISSION/);
      expect(await archivedAt()).toBeNull();
    } finally {
      await db.execute(
        sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${orgId} AND user_id = ${chuong}`,
      );
    }
  });

  it('refuses an item that is not the project itself', async () => {
    const wrong = await archive(chat.alice, 'archive it', 'some-other-project');
    expect(code(wrong.out), JSON.stringify(wrong.out)).toBe('SUPPORT_FORGE_ACT_SHAPE');
    expect(await archivedAt()).toBeNull();
  });

  it('refuses a project with a release run live, and one with a production deploy waiting on a confirm, saying which', async () => {
    const { runId } = await cutAndAsk(w.projectId, w.ownerId, '0.40.0');
    const running = await archive(chat.alice, 'archive it');
    expect(code(running.out), JSON.stringify(running.out)).toBe(
      'SUPPORT_ARCHIVE_RELEASE_IN_FLIGHT',
    );
    expect(JSON.stringify(running.out)).toContain('0.40.0');
    await markPendingHumanConfirm({ runId, issueId: null, bindingId: prodBinding });
    const parked = await archive(chat.alice, 'archive it');
    expect(code(parked.out), JSON.stringify(parked.out)).toBe(
      'SUPPORT_ARCHIVE_DEPLOY_AWAITING_CONFIRM',
    );
    expect(await archivedAt()).toBeNull();
    expect(
      (await rows<{ s: string }>(sql`SELECT status AS s FROM pipeline_runs WHERE id = ${runId}`))[0]
        ?.s,
    ).toBe('running');
    // the release is gone as its owner aborts it: its run and its roster claim leave
    await db.execute(
      sql`UPDATE issues SET release_batch_run_id = NULL WHERE release_batch_run_id = ${runId}`,
    );
    await db.execute(sql`DELETE FROM release_approvals WHERE run_id = ${runId}`);
    await db.execute(sql`DELETE FROM pipeline_runs WHERE id = ${runId}`);
  });

  it('archives it as his: runs stopped, questions withdrawn, groups and deploy bindings off, repository and site untouched, no row deleted', async () => {
    const run = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
      VALUES (${run}, ${w.projectId}, 'system', 'running', now(), '{}'::jsonb)`);
    await db.execute(sql`
      INSERT INTO agent_questions (id, project_id, status, blocker_kind, steps)
      VALUES (${randomUUID()}, ${w.projectId}, 'open', 'human', '[]'::jsonb)`);
    expect(await openQuestions()).toBe(1);
    const issues = await count('issues');
    const bindings = await count('integration_bindings');
    const rooms = await count('support_rooms');
    const queued = await queuedForDeploy();
    outbound.length = 0;

    const his = await archive(chat.alice, 'ok, remove this project');
    expect(code(his.out), JSON.stringify(his.out)).toBeUndefined();
    expect(his.out).toMatchObject({ act: 'project.archive', key: slug, project: slug });
    const said = String((his.out as { recorded?: string }).recorded);
    expect(said).toMatch(/\d+ run\(s\) and 0 job\(s\) stopped/);
    expect(said).toContain('1 question(s) withdrawn');
    expect(said).toContain('repository');

    expect(await archivedAt()).not.toBeNull();
    expect(
      (await rows<{ s: string }>(sql`SELECT status AS s FROM pipeline_runs WHERE id = ${run}`))[0]
        ?.s,
    ).toBe('cancelled');
    expect(await openQuestions()).toBe(0);
    // the groups and every deploy binding are switched off; the source binding, if any, is not read
    expect(
      (await activeBindings()).filter((b) => b.provider === 'rocketchat' || b.role === 'deploy'),
    ).toEqual([]);

    // reversible, and nothing deleted
    expect(await count('issues')).toBe(issues);
    expect(await count('integration_bindings')).toBe(bindings);
    expect(await count('support_rooms')).toBe(rooms);
    // no deploy was asked of any target, and no call left for a deploy target or a git host
    expect(await queuedForDeploy()).toBe(queued);
    const strangers = outbound.filter((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(u));
    expect(strangers).toEqual([]);
    expect(outbound.filter((u) => /coolify|github|gitlab|\/deploy/i.test(u))).toEqual([]);
  });
});
