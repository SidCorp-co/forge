import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { randomUUID } from 'node:crypto';
import { getStorage } from '../../src/integrations/index.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { AgentWorld, agentBlock } from '../helpers/support-agent-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/master-post-edit.ts
// @direct-test-of packages/core/src/support/master-post.ts
// @direct-test-of packages/core/src/integrations/rocketchat/outbound.ts
// @direct-test-of packages/core/src/integrations/rocketchat/room-media.ts
// @direct-test-of packages/contracts/src/support-channel.ts
//
// ISS-1238 (FB-643): two step messages a master posted for the owner's guide could not be taken back,
// since the master-posts door served POST only. A master now edits or deletes a post it made there,
// within thirty minutes of posting, and each act is recorded on the room with who and when. Another
// account's post, another project's, a message that is no master post, one past the window and one
// already deleted are each refused by name, and the room is left as it was. An edit is screened as
// the post was, so it cannot carry what the post could not.
//
// The world binds the agent over two groups: rid, read by users, and rid2, the owner's room.

const w = new AgentWorld();
let chat: StandInRocketChat;
let owner = '';

const FIRST = 'Bước 1: mở trang cài đặt.';
const FIXED = 'Bước 1: mở trang Cài đặt ở góc phải.';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const at = (projectId: string, messageId: string) =>
  `/api/projects/${projectId}/support/master-posts/${messageId}`;
const post = (body: unknown) =>
  api(owner, 'POST', `/api/projects/${w.projectId}/support/master-posts`, body);
const edit = (messageId: string, text: string, token = owner, projectId = w.projectId) =>
  api(token, 'PATCH', at(projectId, messageId), { text });
const remove = (messageId: string, token = owner, projectId = w.projectId) =>
  api(token, 'DELETE', at(projectId, messageId));
const codeOf = (res: { body: unknown }) =>
  (res.body as { error?: { refusals?: { code: string }[] } }).error?.refusals?.[0]?.code;
const detailOf = (res: { body: unknown }) =>
  (res.body as { error?: { refusals?: { detail: string }[] } }).error?.refusals?.[0]?.detail ?? '';

/** Everything the room shows and the record holds of edits and deletes, to compare across a refusal. */
const roomState = async () =>
  JSON.stringify({
    lines: [...chat.linesIn(chat.rid), ...chat.linesIn(chat.rid2)],
    deleted: chat.deletedLines.length,
    acts: await rows(sql`
      SELECT count(*)::int AS n FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND tool IN ('master_post_edit', 'master_post_delete')`),
  });

/** A master post in the owner's room (its report thread), answering its message id. */
async function posted(text = FIRST, body: Record<string, unknown> = {}): Promise<string> {
  const res = await post({ text, rid: chat.rid2, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { messageId: string }).messageId;
}
const lineOf = (id: string) => chat.linesIn(chat.rid2).find((l) => l.id === id);

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  owner = await userToken(w.ownerId);
  const users = await w.retarget({
    agent: { ...agentBlock([w.devTarget], chat.rid2), readers: 'users' },
  });
  if (users.status >= 300) throw new Error(`binding users: ${JSON.stringify(users.body)}`);
  await w.settleWarm();
}, 120_000);

afterAll(() => w.stop());

describe('ISS-1238: a master edits or deletes its own post within the window', () => {
  it('edits its post in the room, and records who changed it, when, and from what', async () => {
    const id = await posted();
    const res = await edit(id, FIXED);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(lineOf(id)?.text).toBe(FIXED);
    expect(res.body).toMatchObject({ rid: chat.rid2, messageId: id, text: FIXED });
    const [act] = await rows<{
      kind: string;
      input: Record<string, unknown>;
      created_at: Date;
    }>(sql`
      SELECT kind, input, created_at FROM support_actions
       WHERE external_id = ${id} AND tool = 'master_post_edit'`);
    expect(act?.kind).toBe('operation');
    expect(act?.input).toMatchObject({ messageId: id, by: w.ownerId, before: FIRST, text: FIXED });
    expect(new Date(String((res.body as { editedAt: string }).editedAt)).getTime()).toBe(
      new Date(String(act?.created_at)).getTime(),
    );
    // a second edit records the first edit's words as what it replaced
    expect((await edit(id, FIRST)).status).toBe(200);
    const [second] = await rows<{ before: string }>(sql`
      SELECT input->>'before' AS before FROM support_actions
       WHERE external_id = ${id} AND tool = 'master_post_edit' ORDER BY created_at DESC LIMIT 1`);
    expect(second?.before).toBe(FIXED);
  });

  it('screens an edit as the post was: a code a users thread may not read is refused, nothing changed', async () => {
    const asked = (await w.hear(() => chat.say(chat.bob, 'Làm sao để đổi mật khẩu?'))).id;
    const res = await post({ text: 'Bạn vào trang Cài đặt nhé.', thread: asked });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = (res.body as { messageId: string }).messageId;
    const before = await roomState();
    const coded = await edit(id, 'Đã xong ISS-89, commit 3971924c4.');
    expect([coded.status, codeOf(coded)], JSON.stringify(coded.body)).toEqual([
      400,
      'SUPPORT_INTERNAL_CODE',
    ]);
    expect(await roomState()).toBe(before);
    expect(w.threadLines(chat.rid, asked).at(-1)?.text).toBe('Bạn vào trang Cài đặt nhé.');
  });

  it('deletes its post with the image it carried, and records the delete', async () => {
    const { path } = await getStorage().put(`iss1238/${randomUUID()}/s.png`, PNG, 'image/png');
    const [upload] = await rows<{ id: string }>(sql`
      INSERT INTO issue_attachments (issue_id, uploader_id, name, path, mime, size)
      VALUES (${w.issueId}, ${w.ownerId}, 's.png', ${path}, 'image/png', ${PNG.length}) RETURNING id`);
    const res = await post({
      text: FIRST,
      rid: chat.rid2,
      attachments: [{ target: 'issue', attachmentId: upload?.id }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { messageId: id, attachments } = res.body as {
      messageId: string;
      attachments: { messageId: string }[];
    };
    const image = String(attachments[0]?.messageId);
    expect(lineOf(image)?.file?.mime).toBe('image/png');
    const gone = await remove(id);
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(gone.body).toMatchObject({ messageId: id, deleted: [id, image] });
    expect([lineOf(id), lineOf(image)]).toEqual([undefined, undefined]);
    expect(chat.deletedLines.map((l) => l.id).slice(-2)).toEqual([id, image]);
    const [act] = await rows<{ kind: string; input: Record<string, unknown> }>(sql`
      SELECT kind, input FROM support_actions
       WHERE external_id = ${id} AND tool = 'master_post_delete'`);
    expect(act).toMatchObject({
      kind: 'operation',
      input: { messageId: id, by: w.ownerId, text: FIRST, deleted: [id, image] },
    });
    // deleted once: a second delete, or an edit, is refused by name, nothing changed
    const state = await roomState();
    expect(codeOf(await remove(id))).toBe('SUPPORT_POST_DELETED');
    expect(codeOf(await edit(id, FIXED))).toBe('SUPPORT_POST_DELETED');
    expect(await roomState()).toBe(state);
  });
});

describe('ISS-1238: a post not the caller’s own, or past the window, is refused by name', () => {
  const unchangedOn = async (
    calls: (() => Promise<{ status: number; body: unknown }>)[],
    status: number,
    code: string,
  ) => {
    const before = await roomState();
    for (const call of calls) {
      const res = await call();
      expect([res.status, codeOf(res)], JSON.stringify(res.body)).toEqual([status, code]);
    }
    expect(await roomState(), 'the room and its record are as they were').toBe(before);
  };

  it("refuses another account's post, though that account writes the project", async () => {
    const id = await posted();
    const other = (await createTestUser({ verified: true })).id;
    await addProjectMember(w.projectId, other, 'admin');
    const token = await userToken(other);
    await unchangedOn(
      [() => edit(id, FIXED, token), () => remove(id, token)],
      403,
      'SUPPORT_POST_NOT_YOURS',
    );
    expect(lineOf(id)?.text).toBe(FIRST);
  });

  it("refuses another project's post, named from a project the caller writes", async () => {
    const id = await posted();
    const mine = (await createTestProject(w.ownerId)).id;
    await unchangedOn(
      [() => edit(id, FIXED, owner, mine), () => remove(id, owner, mine)],
      403,
      'SUPPORT_POST_NOT_YOURS',
    );
  });

  it("refuses a member's message, which is no master post, and a message no post is", async () => {
    const asked = (await w.hear(() => chat.say(chat.bob, 'Có ai ở đây không?'))).id;
    await unchangedOn(
      [() => edit(asked, FIXED), () => remove(asked)],
      403,
      'SUPPORT_POST_NOT_YOURS',
    );
    await unchangedOn(
      [() => edit('m-none', FIXED), () => remove('m-none')],
      404,
      'SUPPORT_POST_UNKNOWN',
    );
  });

  it('refuses a post past the thirty-minute window, naming when it was posted', async () => {
    const id = await posted();
    await rows(sql`
      UPDATE support_actions SET created_at = now() - interval '31 minutes'
       WHERE external_id = ${id} AND tool = 'master_post'`);
    await unchangedOn(
      [() => edit(id, FIXED), () => remove(id)],
      409,
      'SUPPORT_POST_EDIT_WINDOW_PASSED',
    );
    expect(detailOf(await edit(id, FIXED))).toContain('within 30 minutes of posting');
    expect(lineOf(id)?.text).toBe(FIRST);
  });

  it('records nothing when the chat server will not change the message', async () => {
    const id = await posted();
    chat.changesRefused = true;
    try {
      await unchangedOn([() => edit(id, FIXED), () => remove(id)], 503, 'SUPPORT_POST_UNCHANGED');
    } finally {
      chat.changesRefused = false;
    }
  });

  it('refuses a caller who cannot write the project before reading the post', async () => {
    const id = await posted();
    const stranger = await userToken((await createTestUser({ verified: true })).id);
    const before = await roomState();
    expect((await edit(id, FIXED, stranger)).status).toBe(403);
    expect((await remove(id, stranger)).status).toBe(403);
    expect(await roomState()).toBe(before);
  });
});
