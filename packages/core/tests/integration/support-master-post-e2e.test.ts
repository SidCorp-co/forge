import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api, userToken } from '../helpers/api.js';
import { createTestUser, rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/master-post.ts
// @direct-test-of packages/core/src/support/routes.ts
//
// ISS-862: the project's master posts its daily review, in its own words, at the top level of the
// project's team room. Core writes none of the words: it picks the room, screens, posts and records
// who posted. A project binding several team rooms is told to name one; a room it does not bind,
// and a caller who cannot write the project, are refused by name, and nothing is posted.

const w = new AgentWorld();
let chat: StandInRocketChat;
let owner = '';
const post = (token: string, body: unknown) =>
  api(token, 'POST', `/api/projects/${w.projectId}/support/master-posts`, body);
const codeOf = (res: { body: unknown }) =>
  (res.body as { error?: { refusals?: { code: string }[] } }).error?.refusals?.[0]?.code;

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  owner = await userToken(w.ownerId);
}, 120_000);

afterAll(() => w.stop());

const REVIEW = 'Hôm nay: 3 issue lên dev, 1 lỗi deploy đã sửa; mai làm tiếp phần thông báo.';

describe("the master's post in its project's room (ISS-862)", () => {
  it('asks which room where the project binds two, and posts nothing', async () => {
    const res = await post(owner, { text: REVIEW });
    expect([res.status, codeOf(res)]).toEqual([400, 'SUPPORT_ROOM_AMBIGUOUS']);
    expect(JSON.stringify(res.body)).toContain(chat.rid2);
    expect(chat.linesIn(chat.rid).filter((l) => !l.tmid)).toEqual([]);
  });

  it('refuses a room the project does not bind, by name', async () => {
    const res = await post(owner, { text: REVIEW, rid: 'not-a-room' });
    expect([res.status, codeOf(res)]).toEqual([404, 'SUPPORT_ROOM_UNKNOWN']);
  });

  it('refuses a caller who cannot write the project', async () => {
    const stranger = await userToken((await createTestUser({ verified: true })).id);
    const res = await post(stranger, { text: REVIEW, rid: chat.rid });
    expect(res.status).toBe(403);
  });

  it('posts the words as given at the top level of the named room, recorded as the caller’s', async () => {
    const res = await post(owner, { text: REVIEW, rid: chat.rid });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as { rid: string }).rid).toBe(chat.rid);
    const top = chat.linesIn(chat.rid).filter((l) => !l.tmid);
    expect(top.map((l) => l.text)).toEqual([REVIEW]);
    expect(chat.linesIn(chat.rid2).filter((l) => !l.tmid)).toEqual([]);
    const [act] = await rows<{ kind: string; tool: string; by: string }>(sql`
      SELECT kind, tool, input->>'by' AS by FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND tool = 'master_post'`);
    expect(act).toEqual({ kind: 'announced', tool: 'master_post', by: w.ownerId });
  });
});
