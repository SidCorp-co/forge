import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { mintPat } from '../../src/credentials/pat.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { SupportWorld } from '../helpers/support-world.js';

// REQ-75 r6 BC-35, ISS-751 fix round r2: a channel record is keyed on a bound group, whoever answers
// it. #webmail is answered by an outside agent, not a Forge session, so it had no room row and its
// seed was refused SUPPORT_CHANNEL_UNKNOWN. A Rocket.Chat binding's `outsideRids` names such groups:
// Forge keeps their record, starts no session and answers nothing there, and the outside agent reads
// the record with its own account's token. The project here holds what #webmail's does: one
// Rocket.Chat binding, switched off, naming another group. The world is support-room-e2e's.

const w = new SupportWorld();
const TEAM = 'GROUP-TEAM';
const BINDINGS = (projectId: string) => `/api/projects/${projectId}/bindings`;
const channels = () => `/api/projects/${w.projectId}/support/channels`;

type Script = typeof import('../../../../scripts/seed-webmail-channel.mjs');
let seed: Script['seed'];
let MEMBERS: Script['MEMBERS'];
let RULES: Script['RULES'];
let bindingId = '';

/** A new binding's document on the world's Rocket.Chat connection, written whole as an admin does. */
function newBinding(target: Record<string, unknown>) {
  const id = crypto.randomUUID();
  return {
    id,
    body: {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/binding-v1.json',
        version: 1,
        id,
        role: 'service',
        connection: w.rcConnectionId,
        active: true,
        target: { provider: 'rocketchat', ...target },
      },
    },
  };
}

/** The project binding as its document reads, and its revision. */
async function held(): Promise<{ revision: number; document: Record<string, unknown> }> {
  const got = await api(w.owner, 'GET', `${BINDINGS(w.projectId)}/${bindingId}`);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return got.body as { revision: number; document: Record<string, unknown> };
}

const said = (into: string[]) => (l: string) => into.push(l);
const codeOf = (body: unknown) => JSON.stringify(body);
const none = async (table: string, where: ReturnType<typeof sql>) =>
  expect(await rows(sql`SELECT 1 FROM ${sql.raw(table)} WHERE ${where}`), table).toHaveLength(0);

beforeAll(async () => {
  await w.start();
  ({ seed, MEMBERS, RULES } = await import('../../../../scripts/seed-webmail-channel.mjs'));
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Mail bot',
    config: { serverUrl: w.chat.serverUrl },
    secrets: { authToken: w.chat.bot.authToken, userId: w.chat.bot.userId },
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  w.rcConnectionId = String((rc.body.connection as { id: string }).id);
}, 120_000);

afterAll(() => w.stop());

describe('REQ-75 r6: a group an outside agent answers keeps its channel record (BC-35)', () => {
  it('refuses a group bound to no project, or only by another project, by name', async () => {
    // with no Rocket.Chat binding at all, the seed names what it needs rather than guess one
    await expect(
      seed({ base: w.core.base, token: w.owner, project: w.projectId, rid: w.chat.rid, log() {} }),
    ).rejects.toThrow(/has no Rocket.Chat binding to name the group .*--connection/);
    const other = await createTestProject(w.ownerId);
    await addProjectMember(other.id, w.ownerId, 'owner');
    const theirs = newBinding({ outsideRids: ['GROUP-THEIRS'] });
    const bound = await api(w.owner, 'PUT', `${BINDINGS(other.id)}/${theirs.id}`, theirs.body);
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    for (const rid of ['GROUP-NOWHERE', 'GROUP-THEIRS']) {
      const read = await api(w.owner, 'GET', `${channels()}/${rid}`);
      expect(read.status, rid).toBe(404);
      expect(codeOf(read.body)).toContain('SUPPORT_CHANNEL_UNKNOWN');
      const rule = await api(w.owner, 'POST', `${channels()}/${rid}/rules`, { text: 'Be brief.' });
      expect(codeOf(rule.body), rid).toContain('SUPPORT_CHANNEL_UNKNOWN');
      const member = await api(w.owner, 'PUT', `${channels()}/${rid}/members/alice`, {
        roles: ['user'],
      });
      expect(codeOf(member.body), rid).toContain('SUPPORT_CHANNEL_UNKNOWN');
    }
    await none('support_channels', sql`project_id = ${w.projectId}::uuid`);
  });

  it('holds one binding naming another group, switched off, as #webmail’s project does', async () => {
    const team = newBinding({ rids: [TEAM] });
    const put = await api(w.owner, 'PUT', `${BINDINGS(w.projectId)}/${team.id}`, team.body);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    bindingId = team.id;
    const off = await api(w.owner, 'DELETE', `${BINDINGS(w.projectId)}/${bindingId}`, {
      baseRevision: (await held()).revision,
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await held()).document).toMatchObject({ active: false, target: { rids: [TEAM] } });
  });

  it('refuses a group named as answered by Forge and by an outside agent at once, or twice', async () => {
    const { revision, document } = await held();
    const target = document.target as Record<string, unknown>;
    const both = await api(w.owner, 'PUT', `${BINDINGS(w.projectId)}/${bindingId}`, {
      baseRevision: revision,
      document: { ...document, target: { ...target, outsideRids: [w.chat.rid, TEAM] } },
    });
    expect(both.status, JSON.stringify(both.body)).toBe(422);
    expect(codeOf(both.body)).toContain('SUPPORT_ROOM_TWO_KINDS');
    expect(codeOf(both.body)).toContain('/outsideRids/1');
    const twice = await api(w.owner, 'PUT', `${BINDINGS(w.projectId)}/${bindingId}`, {
      baseRevision: revision,
      document: { ...document, target: { ...target, outsideRids: [w.chat.rid, w.chat.rid] } },
    });
    expect(twice.status, JSON.stringify(twice.body)).toBe(422);
    expect(codeOf(twice.body)).toContain(
      'SCHEMA_VIOLATION at /target/outsideRids: a group is named once',
    );
    expect((await held()).revision).toBe(revision);
  });
});

describe('REQ-75 r6: #webmail’s seed binds its group answered outside (BC-35)', () => {
  it('a dry run says it would bind the group and writes nothing', async () => {
    const lines: string[] = [];
    const before = await held();
    const out = await seed({
      base: w.core.base,
      token: w.owner,
      project: w.projectId,
      rid: w.chat.rid,
      dry: true,
      log: said(lines),
    });
    expect(lines[0]).toBe(
      `would bind #${w.chat.rid} in binding ${bindingId}, answered by an outside agent`,
    );
    expect(lines.filter((l) => l.startsWith('would confirm @'))).toHaveLength(MEMBERS.length);
    expect(lines.filter((l) => l.startsWith('would add rule: '))).toHaveLength(RULES.length);
    expect(out.memberRows).toEqual([]);
    expect(await held()).toEqual(before);
    await none('support_channels', sql`project_id = ${w.projectId}::uuid`);
  });

  it('names the group in the binding, then writes the member seed confirmed and the rules, read back the same twice', async () => {
    const lines: string[] = [];
    const once = await seed({
      base: w.core.base,
      token: w.owner,
      project: w.projectId,
      rid: w.chat.rid,
      log: said(lines),
    });
    expect(lines[0]).toBe(
      `bound #${w.chat.rid} in binding ${bindingId}, answered by an outside agent`,
    );
    // nothing else of the binding moved: still off, still naming its own group
    expect((await held()).document).toMatchObject({
      active: false,
      target: { rids: [TEAM], outsideRids: [w.chat.rid] },
    });
    for (const m of MEMBERS) {
      expect(once.memberRows.find((r) => r.username === m.username)).toMatchObject({
        roles: m.roles,
        askFor: m.askFor,
        state: 'confirmed',
      });
    }
    expect(once.memberRows).toHaveLength(MEMBERS.length);
    expect(once.ruleRows.map((r) => r.text)).toEqual(RULES);
    const again = await seed({
      base: w.core.base,
      token: w.owner,
      project: w.projectId,
      rid: w.chat.rid,
      log: said(lines),
    });
    expect(again.ruleRows).toHaveLength(RULES.length);
    expect(again.memberRows).toHaveLength(MEMBERS.length);
    expect(lines.filter((l) => l.startsWith('bound #'))).toHaveLength(1);
    // the channel's page under Product lists it beside the binding's own group
    const list = await api(w.owner, 'GET', channels());
    expect(list.body.channels).toEqual([
      { rid: TEAM, name: null, members: 0, rules: 0, commonIssues: 0 },
      {
        rid: w.chat.rid,
        name: null,
        members: MEMBERS.length,
        rules: RULES.length,
        commonIssues: 0,
      },
    ]);
  });

  it('switched on, the binding starts no Forge session for the group, and a member’s message there is answered by nothing in Forge', async () => {
    const { revision, document } = await held();
    const on = await api(w.owner, 'PUT', `${BINDINGS(w.projectId)}/${bindingId}`, {
      baseRevision: revision,
      document: { ...document, active: true },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    await settleOutbox();
    const { declareSupportRooms } = await import('../../src/support/rooms.js');
    expect(await declareSupportRooms(w.projectId)).toEqual([]);
    const { startRocketChatManager, roomForProject } = await import(
      '../../src/integrations/rocketchat/index.js'
    );
    const { buildRoutes } = await import('../../src/integrations/rocketchat/room-routing.js');
    // the connection routes the binding's own group to Forge, and never the group answered outside
    expect([...(await buildRoutes(w.rcConnectionId)).keys()]).toEqual([TEAM]);
    // a routed message is taken into a conversation, as at boot: what this file proves is absent
    const { registerRoomChat } = await import('../../src/assistant/index.js');
    registerRoomChat();
    await startRocketChatManager();
    const id = await w.chat.say(w.chat.alice, 'Webmail will not open for me this morning');
    await new Promise((r) => setTimeout(r, 3_000));
    await settleOutbox();
    expect(await w.chat.botLines()).toEqual([]);
    expect(w.box.turns).toHaveLength(0);
    await none('support_rooms', sql`project_id = ${w.projectId}::uuid`);
    await none('agent_sessions', sql`project_id = ${w.projectId}::uuid`);
    await none('conversation_messages', sql`external_id = ${id}`);
    await none('support_actions', sql`external_id = ${id}`);
    // the team's room, where Forge would post a parked question, is the binding's own group
    expect((await roomForProject(w.projectId))?.rid).toBe(TEAM);
  });

  it('the outside agent reads the record with its own account’s read token, and writes nothing with it', async () => {
    const babo = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, babo.id, 'viewer');
    const token = (
      await mintPat({
        userId: babo.id,
        name: 'babo-webmail',
        permissions: ['projects:read'],
        scopes: ['read'],
        projectIds: [w.projectId],
      })
    ).plaintext;
    const path = `${w.core.base}${channels()}/${w.chat.rid}`;
    const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const { channel } = (await res.json()) as {
      channel: { memberRows: { username: string; state: string }[]; ruleRows: { text: string }[] };
    };
    expect(channel.memberRows.map((m) => `${m.username}:${m.state}`).sort()).toEqual(
      MEMBERS.map((m) => `${m.username}:confirmed`).sort(),
    );
    expect(channel.ruleRows.map((r) => r.text)).toEqual(RULES);
    const write = await fetch(`${path}/rules`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Answer in English only.' }),
    });
    expect(write.status).toBe(403);
    const after = await api(w.owner, 'GET', `${channels()}/${w.chat.rid}`);
    expect((after.body.channel as { ruleRows: unknown[] }).ruleRows).toHaveLength(RULES.length);
  });
});
