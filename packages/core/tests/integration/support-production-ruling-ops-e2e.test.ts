import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { runWithPatScope } from '../../src/credentials/pat-scope.js';
import { ownerForgeAct } from '../../src/support/owner-forge-act.js';
import { insertAction, type RoomRow, roomsOfProject } from '../../src/support/store.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestIssue, createTestUser, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/owner-ruling-act.ts
// @direct-test-of packages/core/src/support/owner-forge-act.ts
//
// ISS-1431 (REQ-80 BC-11) in an operations room, the team's own: each writer acts as himself, so a
// project admin's ruling for a production act given there is recorded on the issue as that admin's,
// a person's decision naming the act and the environment, their message quoted; a member without
// project.admin and a writer Forge cannot name are refused by name, nothing recorded.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const BABO = {
  name: 'babo',
  persona:
    'You are Babo. You coordinate Forge and delivery for the team: projects, issues, runners and releases.',
  grants: ['read', 'deliver'],
};
const THREAD = 'XQHEiGjSv8HTytmpY';
const ACT = 'Set supplier PGPrints on production';

const w = new SupportWorld();
let chat: StandInRocketChat;
let slug = '';
let room: RoomRow;
let admin = '';
let issue = { id: '', key: '' };

const codeOf = (out: { ok: boolean; refusals?: { code: string; detail: string }[] }) =>
  out.ok ? null : out.refusals?.[0]?.code;

/** `who` writes `text` in the thread, as the chat server signed it; the message's id. */
async function says(who: { userId: string; username: string }, text: string): Promise<string> {
  const message = `m-${who.username}-${Date.now()}`;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: THREAD,
    kind: 'message_in',
    actorKind: 'member',
    actorKey: who.userId,
    actorLabel: who.username,
    externalId: message,
    input: { text },
  });
  return message;
}

/** The ruling act, citing `message`, under the turn's token as the room's session runs it. */
const rule = (message: string) =>
  runWithPatScope(
    {
      projectIds: [w.projectId],
      tokenId: '00000000-0000-4000-8000-000000001431',
      userId: w.ownerId,
      agency: 'agent',
      grant: ['*'],
      scopes: ['read', 'write'],
    },
    () =>
      ownerForgeAct(room, {
        thread: THREAD,
        message,
        project: slug,
        act: 'issue.rule_production',
        item: issue.key,
        ruling: { act: ACT, environment: 'production' },
      }),
  );

const rulings = () =>
  rows<{ actor_id: string; actor_agency: string; why: string | null }>(sql`
    SELECT actor_id, actor_agency,
           (SELECT f->>'value' FROM jsonb_array_elements(payload->'fields') f WHERE f->>'key' = 'why') AS why
      FROM activity_log WHERE issue_id = ${issue.id}::uuid AND action = 'record.decision'`);

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  [{ slug } = { slug: '' }] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Babo',
    config: { serverUrl: chat.serverUrl, role: BABO },
    secrets: { authToken: chat.bot.authToken, userId: chat.bot.userId },
    bindings: [
      {
        projectId: w.projectId,
        role: 'service',
        target: { provider: 'rocketchat', rids: [chat.rid], operations: { scope: 'project' } },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  await settleOutbox();
  await w.settleWarm();
  const declared = (await roomsOfProject(w.projectId)).find((r) => r.kind === 'operations');
  if (!declared) throw new Error('the operations room was not declared');
  room = declared;
  await seedProjectDocument(w.projectId, w.ownerId, {
    environments: {
      production: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
    },
  });
  // alice administers the project and bob only reads it; carol is nobody Forge can name
  admin = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, admin, 'admin');
  const viewer = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, viewer, 'viewer');
  const namespace = new URL(chat.serverUrl).host;
  for (const [member, userId] of [
    [chat.alice, admin],
    [chat.bob, viewer],
  ] as const) {
    await rows(sql`
      INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
      VALUES ('rocketchat', ${namespace}, ${member.userId}, ${member.username}, ${userId}, 'channel_email_match')`);
  }
  const made = await createTestIssue(w.projectId, w.ownerId, 1431, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  issue = { id: made.id, key: made.key };
}, 120_000);

afterAll(() => w.stop());

describe('ISS-1431: a production ruling given in an operations room is its writer’s own', () => {
  it('refuses a member without project.admin and a writer Forge cannot name, recording nothing', async () => {
    const viewer = await rule(await says(chat.bob, 'config giùm cái đi'));
    expect(codeOf(viewer), JSON.stringify(viewer)).toBe('PERMISSION_FORBIDDEN');
    expect(JSON.stringify(viewer)).toContain('project.admin');
    const unnamed = await rule(await says(chat.carol, 'config giùm cái đi'));
    expect(codeOf(unnamed), JSON.stringify(unnamed)).toBe('OPS_ASKER_UNMAPPED');
    expect(await rulings()).toEqual([]);
  });

  it('records a project admin’s ruling as theirs, a person’s, quoting their message', async () => {
    const message = await says(chat.alice, 'Config PGPrints trên production giùm cái đi');
    const out = await rule(message);
    expect(out, JSON.stringify(out)).toMatchObject({
      ok: true,
      value: { act: 'issue.rule_production', key: issue.key },
    });
    const [held] = await rulings();
    expect(held).toMatchObject({ actor_id: admin, actor_agency: 'human' });
    expect(held?.why).toContain(message);
    expect(held?.why).toContain('Config PGPrints trên production');
  });
});
