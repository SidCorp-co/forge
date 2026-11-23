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

// @direct-test-of packages/core/src/support/owner-confirm-deploy-act.ts
// @direct-test-of packages/core/src/support/owner-forge-act.ts
// @direct-test-of packages/core/src/release-batch/confirm-prod-door.ts
//
// ISS-1441 (FB-838, FB-842): sidpeak 0.32.0's owner said "ok" in his room to the production deploy
// its release run had parked on a confirm, and no room act could record it: support.owner_forge_act
// refused release.confirmDeploy as an act no door from chat makes, the master's credential was
// refused the confirm door's project.admin, and the run stood waiting on a button press. The room now
// confirms it as the owner whose message gave it, under his own project.admin, through the page's
// own confirm door, and the run carries on. Anyone else's message, one he did not write, an account
// without project.admin, and a release with no deploy waiting are refused by name, nothing confirmed.

const VERSION = '0.32.0';

const w = new AgentWorld();
let chat: StandInRocketChat;
let slug = '';
let chuong = '';
let runId = '';
let bindingId = '';

/** `who` writes `text`; the session asks for the confirm as their act, citing `cite(message)`. */
async function confirm(
  who: typeof chat.alice,
  text: string,
  item = VERSION,
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
        act: 'release.confirmDeploy',
        item,
      });
    },
  );
  return { id: heard.id, thread: heard.message.thread, out };
}

type Gate = { confirmedAt: string | null; confirmedByUserId?: string; confirmedCited?: object };
const runOf = async () =>
  (
    await rows<{ step: string | null; gate: Record<string, Gate> | null }>(sql`
      SELECT current_step AS step, metadata->'__forge_prod_deploy_gate' AS gate
        FROM pipeline_runs WHERE id = ${runId}`)
  )[0];

const dispatched = async () =>
  (
    await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pgboss_v12.job
       WHERE name = 'forge.integrations' AND data->>'bindingId' = ${bindingId}
         AND data->>'jobKind' = 'coolify.dispatch'`)
  )[0]?.n ?? 0;

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
  // production deploys on request through its Coolify binding, beside the world's dev target
  ({ bindingId } = await seedProduction({
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
  // the release run cut as 0.32.0, its production deploy parked for a person's confirm
  ({ runId } = await cutAndAsk(w.projectId, w.ownerId, VERSION));
  await markPendingHumanConfirm({ runId, issueId: null, bindingId });
}, 120_000);

afterAll(async () => {
  await w.stop();
});

describe("ISS-1441: the owner's confirm of a parked production deploy, given in his room", () => {
  it('refuses a message by anyone but the owner, or one he did not write, and confirms nothing', async () => {
    const bobs = await confirm(chat.bob, 'ok deploy production đi');
    expect(code(bobs.out), JSON.stringify(bobs.out)).toBe('SUPPORT_FORGE_ACT_NOT_THE_OWNER');
    const unnamed = await confirm(chat.alice, 'ok', VERSION, (h) => ({
      thread: h.thread,
      message: 'no-such-message',
    }));
    expect(code(unnamed.out), JSON.stringify(unnamed.out)).toBe(
      'SUPPORT_FORGE_ACT_NOT_HIS_MESSAGE',
    );
    expect((await runOf())?.gate?.[bindingId]).toMatchObject({ confirmedAt: null });
    expect(await dispatched()).toBe(0);
  });

  it("refuses the owner's word where his own account holds no project.admin, naming it", async () => {
    await db.execute(sql`
      UPDATE project_members SET role = 'member' WHERE project_id = ${w.projectId} AND user_id = ${chuong}`);
    try {
      const member = await confirm(chat.alice, 'ok');
      expect(code(member.out), JSON.stringify(member.out)).toBe('PERMISSION_FORBIDDEN');
      expect(JSON.stringify(member.out)).toContain('project.admin');
      expect((await runOf())?.gate?.[bindingId]).toMatchObject({ confirmedAt: null });
    } finally {
      await db.execute(sql`
        UPDATE project_members SET role = 'admin' WHERE project_id = ${w.projectId} AND user_id = ${chuong}`);
    }
  });

  it('refuses a release no run was cut as, or one named by part of its version', async () => {
    const uncut = await confirm(chat.alice, 'ok 0.31.0', '0.31.0');
    expect(code(uncut.out), JSON.stringify(uncut.out)).toBe('SUPPORT_CONFIRM_DEPLOY_NOT_WAITING');
    const partial = await confirm(chat.alice, 'ok 0.32', '0.32');
    expect(code(partial.out), JSON.stringify(partial.out)).toBe(
      'SUPPORT_RELEASE_VERSION_AMBIGUOUS',
    );
    expect(await dispatched()).toBe(0);
  });

  it('confirms it as his, citing his message, and the release run carries on; a second word is refused', async () => {
    const his = await confirm(chat.alice, 'ok');
    expect(code(his.out), JSON.stringify(his.out)).toBeUndefined();
    expect(his.out).toMatchObject({ act: 'release.confirmDeploy', key: VERSION, project: slug });
    const run = await runOf();
    // his press, through the page's own door: the gate names him and the message it was read from
    expect(run?.gate?.[bindingId]).toMatchObject({
      confirmedByUserId: chuong,
      confirmedCited: { message: his.id, thread: his.thread, rid: chat.rid },
    });
    expect(run?.gate?.[bindingId]?.confirmedAt).toEqual(expect.any(String));
    expect(run?.step).toBe('release.deploy.in_flight');
    expect(await dispatched()).toBe(1);

    // nothing waits on a confirm any more: a second word is refused, and nothing is sent twice
    const again = await confirm(chat.alice, 'ok lần nữa');
    expect(code(again.out), JSON.stringify(again.out)).toBe('SUPPORT_CONFIRM_DEPLOY_NOT_WAITING');
    expect(await dispatched()).toBe(1);

    // the act and each refusal are on the room's record beside his message
    const acts = await rows<{ kind: string; input: { act: string; message: string } }>(sql`
      SELECT kind, input FROM support_actions
       WHERE project_id = ${w.projectId} AND tool = 'owner_forge_act' ORDER BY created_at`);
    expect(acts.filter((a) => a.kind === 'operation').map((a) => a.input.message)).toEqual([
      his.id,
    ]);
    expect(acts.filter((a) => a.kind === 'refused')).toHaveLength(6);
  });
});
