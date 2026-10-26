// REQ-75 r4 BC-20..BC-24, end to end: two bot accounts on one chat server, each with its role on
// its rocketchat connection — babo (read, deliver) in an organization-wide operations room and in
// one project's group, sy (read, draft, research) in an organization-wide room — answered by
// sessions on a box, through forge_support under each turn's token. A write runs as the thread's
// latest writer under that member's own permissions; the role's grant and the room's scope are
// checked first. The chat server is `ops-chat-server.ts`'s: a stand-in, or a real Rocket.Chat.

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // each bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { settleOutbox, startQueue } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  seedOrg,
} from '../helpers/factories.js';
import {
  MEMBERS,
  type MemberName,
  type OpsChat,
  opsChat,
  type RoomName,
} from '../helpers/ops-chat-server.js';
import { boxToken, type Served, serveCore } from '../helpers/preview-world.js';
import { SessionBox } from '../helpers/support-world.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const BABO = {
  name: 'babo',
  persona:
    'You are Babo. You coordinate Forge and delivery for the team: projects, issues, runners, masters and releases. You never decide product direction.',
  grants: ['read', 'deliver'],
};
const SY = {
  name: 'sy',
  persona:
    'You are Sy. You work on product direction, requirements, feedback and research, as drafts a person decides. You never move delivery.',
  grants: ['read', 'draft', 'research'],
};

/** The acts that name the thread they are taken for. */
const THREADED = new Set(['move', 'draft_requirement', 'draft_feedback', 'research', 'record']);

let core: Served;
let chat: OpsChat;
let box: SessionBox;
let owner = '';
const ids = { alice: '', bob: '', dana: '' };
const home = { forge: '', catalog: '', social: '' };
const slug = { forge: '', catalog: '', social: '' };
/** What the session's tool answered for each thread's command. */
const answered = new Map<string, Record<string, unknown>>();

beforeAll(async () => {
  await startQueue();
  const { registerSupportRooms } = await import('../../src/support/index.js');
  registerSupportRooms();
  chat = await opsChat();
  const alice = await createTestUser({ verified: true, email: MEMBERS.alice.email(chat.tag) });
  const bob = await createTestUser({ verified: true, email: MEMBERS.bob.email(chat.tag) });
  const dana = await createTestUser({ verified: true });
  ids.alice = alice.id;
  ids.bob = bob.id;
  ids.dana = dana.id;
  owner = await userToken(alice.id);
  const org = await seedOrg(alice.id);
  for (const name of ['forge', 'catalog', 'social'] as const) {
    const p = await createTestProject(alice.id, { orgId: org });
    home[name] = p.id;
    slug[name] = p.slug;
    await addProjectMember(p.id, alice.id, 'owner');
  }
  // bob only reads the catalog; dana administers it
  await addProjectMember(home.catalog, bob.id, 'viewer');
  await addProjectMember(home.catalog, dana.id, 'admin');
  for (let seq = 1; seq <= 6; seq++) {
    await createTestIssue(home.catalog, alice.id, seq, { status: 'open', createdAt: new Date() });
  }
  core = await serveCore();
  const deviceId = await createTestDevice(alice.id);
  for (const id of Object.values(home)) await bindTestRunner(id, deviceId);
  await db.execute(sql`UPDATE runners SET last_seen_at = now() WHERE device_id = ${deviceId}`);
  await db.execute(
    sql`UPDATE devices SET capabilities = '{"followUpCredential": true, "turnCredential": true, "confinedChatNetwork": true}'::jsonb WHERE id = ${deviceId}`,
  );
  box = new SessionBox(core.base, await boxToken(alice.id, deviceId), deviceId);
  await box.connect();
  box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from === 'forge' || !m.text.startsWith('do ')) continue;
      const args = JSON.parse(m.text.slice(3)) as Record<string, unknown>;
      const out = await act({
        ...args,
        ...(THREADED.has(String(args.action)) ? { thread: m.thread } : {}),
      });
      answered.set(m.thread, out);
      await act({ action: 'reply', thread: m.thread, text: out.isError ? 'refused' : 'done' });
    }
  };

  // dave's chat address is bob's; the confirmed link names him dana, and the link wins
  const namespace = new URL(chat.serverUrl).host;
  await db.execute(sql`
    INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
    VALUES ('rocketchat', ${namespace}, ${chat.members.dave.userId}, 'dave', ${dana.id}, 'channel_email_match')`);

  const babo = await api(owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Babo',
    config: { serverUrl: chat.serverUrl, role: BABO },
    secrets: chat.bots.babo,
    bindings: [
      {
        projectId: home.forge,
        role: 'service',
        target: { provider: 'rocketchat', rids: [chat.rooms.ops], operations: { scope: 'forge' } },
      },
      {
        projectId: home.catalog,
        role: 'service',
        target: {
          provider: 'rocketchat',
          rids: [chat.rooms.group],
          operations: { scope: 'project' },
        },
      },
    ],
  });
  expect(babo.status, JSON.stringify(babo.body)).toBe(201);
  const sy = await api(owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Sy',
    config: { serverUrl: chat.serverUrl, role: SY },
    secrets: chat.bots.sy,
    bindings: [
      {
        projectId: home.social,
        role: 'service',
        target: {
          provider: 'rocketchat',
          rids: [chat.rooms.social],
          operations: { scope: 'forge' },
        },
      },
    ],
  });
  expect(sy.status, JSON.stringify(sy.body)).toBe(201);
  await settleOutbox();
  const { startRocketChatManager } = await import('../../src/integrations/rocketchat/index.js');
  await startRocketChatManager();
  await settleWarm();
});

afterAll(async () => {
  const { stopRocketChatManager } = await import('../../src/integrations/rocketchat/index.js');
  await stopRocketChatManager();
  box?.close();
  await chat?.close();
  const { stopCore } = await import('../helpers/preview-world.js');
  if (core) await stopCore(core);
  const { closeWorld } = await import('../helpers/ecosystem-world.js');
  await closeWorld();
  if (box?.errors.length) throw new AggregateError(box.errors, 'the session box failed a turn');
});

async function rooms(): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (const id of Object.values(home)) {
    const got = await api(owner, 'GET', `/api/projects/${id}/support/rooms`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    all.push(...(got.body.rooms as Record<string, unknown>[]));
  }
  return all;
}

/** Every room's session warmed and resting resident, with no turn running on the box. */
async function settleWarm(ms = 30_000): Promise<void> {
  const { warmColdRooms } = await import('../../src/support/index.js');
  const until = Date.now() + ms;
  let quiet = 0;
  while (quiet < 3) {
    if (Date.now() > until) throw new Error(`the rooms were still warming after ${ms}ms`);
    await settleOutbox();
    await warmColdRooms();
    const all = await rooms();
    const settled =
      all.length === 3 &&
      all.every((r) => r.resident === true && r.sessionStatus === 'completed') &&
      box.idle();
    quiet = settled ? quiet + 1 : 0;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** `who` asks in `room` for one act; what the tool answered the session. */
async function ask(
  who: MemberName,
  room: RoomName,
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await settleWarm();
  const thread = await chat.say(who, room, `do ${JSON.stringify(command)}`);
  await expect.poll(() => answered.has(thread), { timeout: 30_000, interval: 50 }).toBe(true);
  await expect
    .poll(async () => (await chat.botLines(room)).some((l) => l.tmid === thread), {
      timeout: 15_000,
    })
    .toBe(true);
  return answered.get(thread) as Record<string, unknown>;
}

const refusal = (out: Record<string, unknown>) =>
  ((out.error as { refusals?: { code: string; detail: string }[] } | undefined)?.refusals ?? [])[0];

async function statusOf(seq: number): Promise<string> {
  const [row] = await rows<{ status: string }>(
    sql`SELECT status FROM issues WHERE project_id = ${home.catalog}::uuid AND iss_seq = ${seq}`,
  );
  return String(row?.status);
}

const move = (seq: number) => ({
  action: 'move',
  issue: `ISS-${seq}`,
  project: slug.catalog,
  to: 'on_hold',
  reason: 'paused from the operations room',
});

describe('REQ-75 r4: operations rooms answer under their bot’s role (BC-20..BC-24)', () => {
  it('declares a room per attached rid, each with its own session, kind, scope and role (BC-20, BC-22)', async () => {
    const all = await rooms();
    expect(all.map((r) => [r.rid, r.kind, r.scope, r.role]).sort()).toEqual(
      [
        [chat.rooms.group, 'operations', 'project', 'babo'],
        [chat.rooms.ops, 'operations', 'forge', 'babo'],
        [chat.rooms.social, 'operations', 'forge', 'sy'],
      ].sort(),
    );
    expect(new Set(all.map((r) => r.sessionId)).size).toBe(3);
  });

  it('runs a mapped admin’s command as that admin, the turn’s token acting for them (BC-21)', async () => {
    const out = await ask('alice', 'ops', move(1));
    expect(out, JSON.stringify(out)).toMatchObject({ issue: 'ISS-1', from: 'open', to: 'on_hold' });
    expect(await statusOf(1)).toBe('on_hold');
    const [moved] = await rows<{
      actor_id: string;
      actor_agency: string;
      actor_token_id: string | null;
      actor_on_behalf_of: string | null;
    }>(sql`SELECT k.actor_id, k.actor_agency, k.actor_token_id, k.actor_on_behalf_of
             FROM kernel_transitions k JOIN issues i ON i.id = k.entity_id
            WHERE k.entity = 'issue' AND i.project_id = ${home.catalog}::uuid AND i.iss_seq = 1
            ORDER BY k.created_at DESC LIMIT 1`);
    expect(moved).toMatchObject({
      actor_id: ids.alice,
      actor_agency: 'agent',
      actor_on_behalf_of: ids.alice,
    });
    expect(moved?.actor_token_id).toBeTruthy();
  });

  it('refuses a mapped member without the permission, naming it (BC-21)', async () => {
    const out = await ask('bob', 'ops', move(2));
    expect(refusal(out)?.code, JSON.stringify(out)).toBe('PERMISSION_FORBIDDEN');
    expect(refusal(out)?.detail).toContain('project.write');
    expect(await statusOf(2)).toBe('open');
  });

  it('lets an unmapped member read and nothing else, and maps no unverified address (BC-21)', async () => {
    const read = await ask('carol', 'ops', { action: 'issues', project: slug.catalog });
    expect(read, JSON.stringify(read)).toMatchObject({ project: slug.catalog, total: 6 });
    for (const who of ['carol', 'eve'] as const) {
      const out = await ask(who, 'ops', move(3));
      expect(refusal(out)?.code, `${who}: ${JSON.stringify(out)}`).toBe('OPS_ASKER_UNMAPPED');
      expect(refusal(out)?.detail).toContain('can only read');
    }
    expect(await statusOf(3)).toBe('open');
  });

  it('names a member by the explicit link over the address the chat server gives (BC-21)', async () => {
    const out = await ask('dave', 'ops', move(4));
    expect(out, JSON.stringify(out)).toMatchObject({ to: 'on_hold' });
    const [moved] = await rows<{ actor_id: string }>(
      sql`SELECT k.actor_id FROM kernel_transitions k JOIN issues i ON i.id = k.entity_id
           WHERE k.entity = 'issue' AND i.project_id = ${home.catalog}::uuid AND i.iss_seq = 4
           ORDER BY k.created_at DESC LIMIT 1`,
    );
    expect(moved?.actor_id).toBe(ids.dana);
  });

  it('sy refuses a delivery move by name and drafts direction a person decides (BC-24)', async () => {
    const out = await ask('alice', 'social', move(5));
    expect(refusal(out)?.code, JSON.stringify(out)).toBe('OPS_ROLE_NOT_GRANTED');
    expect(refusal(out)?.detail).toContain('the sy role is not granted `deliver`');
    expect(await statusOf(5)).toBe('open');
    const drafted = await ask('alice', 'social', {
      action: 'draft_requirement',
      project: slug.catalog,
      title: 'Bulk price edits from the catalog list',
      summary: 'Shop staff ask to change many prices at once from the list view.',
    });
    expect(drafted, JSON.stringify(drafted)).toMatchObject({ status: 'draft' });
    const [req] = await rows<{ status: string }>(
      sql`SELECT status FROM requirements WHERE project_id = ${home.catalog}::uuid`,
    );
    expect(req?.status).toBe('draft');
  });

  it('babo refuses to draft product direction, leaving it to a person (BC-23)', async () => {
    const [before] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM requirements WHERE project_id = ${home.catalog}::uuid`,
    );
    const out = await ask('alice', 'ops', {
      action: 'draft_requirement',
      project: slug.catalog,
      title: 'Drop the catalog export',
      summary: 'Decide to drop the export feature.',
    });
    expect(refusal(out)?.code, JSON.stringify(out)).toBe('OPS_ROLE_NOT_GRANTED');
    expect(refusal(out)?.detail).toContain('the babo role is not granted `draft`');
    expect(refusal(out)?.detail).toContain('decided by a person');
    const [after] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM requirements WHERE project_id = ${home.catalog}::uuid`,
    );
    expect(after?.n).toBe(before?.n);
  });

  it('gives two rooms of one bot account their own scopes (BC-20)', async () => {
    const wide = await ask('alice', 'ops', { action: 'projects' });
    expect(((wide.projects as { slug: string }[]) ?? []).map((p) => p.slug).sort()).toEqual(
      Object.values(slug).sort(),
    );
    const narrow = await ask('alice', 'group', { action: 'projects' });
    expect(((narrow.projects as { slug: string }[]) ?? []).map((p) => p.slug)).toEqual([
      slug.catalog,
    ]);
    const outside = await ask('alice', 'group', { action: 'issues', project: slug.forge });
    expect(refusal(outside)?.code, JSON.stringify(outside)).toBe('OPS_OUT_OF_SCOPE');
  });

  it('refuses a support group’s acts, research the role lacks, and a page that is not public', async () => {
    const record = await ask('alice', 'ops', {
      action: 'record',
      kind: 'defect',
      title: 'Not a support group',
      summary: 'This room files nothing as a support group would.',
    });
    expect(refusal(record)?.code, JSON.stringify(record)).toBe('SUPPORT_NOT_A_SUPPORT_ROOM');
    const babo = await ask('alice', 'ops', { action: 'research', url: 'https://example.com/' });
    expect(refusal(babo)?.code, JSON.stringify(babo)).toBe('OPS_ROLE_NOT_GRANTED');
    const inside = await ask('alice', 'social', { action: 'research', url: 'https://127.0.0.1/' });
    expect(refusal(inside)?.code, JSON.stringify(inside)).toBe('OPS_RESEARCH_REFUSED');
    expect(refusal(inside)?.detail).toContain('not a public address');
  });
});
