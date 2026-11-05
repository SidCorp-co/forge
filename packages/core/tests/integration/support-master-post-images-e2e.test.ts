import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { randomUUID } from 'node:crypto';
import { getStorage } from '../../src/integrations/index.js';
import { api, userToken } from '../helpers/api.js';
import { createTestIssue, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { AgentWorld, agentBlock } from '../helpers/support-agent-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/master-post.ts
// @direct-test-of packages/core/src/support/master-post-images.ts
// @direct-test-of packages/core/src/integrations/rocketchat/room-media.ts
// @direct-test-of packages/contracts/src/support-channel.ts
//
// ISS-1024 (FB-526): the agenfold owner asked for his agent's release checks to reach his thread with
// their screenshots, and a master's post carried text only. A post now names up to four images by
// their Forge upload ids; each is checked before anything is posted, uploaded unposted, and posted
// after the text in the same room and thread, through the same admission the text takes. An item that
// is no image, too large, unreadable to the caller or unknown is refused by name, nothing posted.
//
// The world binds the agent over two groups: rid, read by users, and rid2, the owner's room.

const w = new AgentWorld();
let chat: StandInRocketChat;
let owner = '';
let issueId = '';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const RESULT = 'Đã kiểm tra bản phát hành, ảnh chụp màn hình bên dưới.';

const post = (body: unknown) =>
  api(owner, 'POST', `/api/projects/${w.projectId}/support/master-posts`, body);
const refusalsOf = (res: { body: unknown }) =>
  (res.body as { error?: { refusals?: { code: string; path: string; detail: string }[] } }).error
    ?.refusals ?? [];
const allLines = () => chat.linesIn(chat.rid).length + chat.linesIn(chat.rid2).length;

/** An upload on an issue, as `POST /api/issues/:id/attachments` stores one; `size` overrides the row's. */
async function attach(
  onIssue: string,
  name: string,
  mime: string,
  bytes: Buffer,
  size = bytes.length,
): Promise<string> {
  const { path } = await getStorage().put(`iss1024/${randomUUID()}/${name}`, bytes, mime);
  const [row] = await rows<{ id: string }>(sql`
    INSERT INTO issue_attachments (issue_id, uploader_id, name, path, mime, size)
    VALUES (${onIssue}, ${w.ownerId}, ${name}, ${path}, ${mime}, ${size}) RETURNING id`);
  return String(row?.id);
}
const issueImage = (attachmentId: string) => ({ target: 'issue', attachmentId });

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  owner = await userToken(w.ownerId);
  issueId = w.issueId;
  const users = await w.retarget({
    agent: { ...agentBlock([w.devTarget], chat.rid2), readers: 'users' },
  });
  if (users.status >= 300) throw new Error(`binding users: ${JSON.stringify(users.body)}`);
  await w.settleWarm();
}, 120_000);

afterAll(() => w.stop());

describe("ISS-1024: a master's post carries images into the text's own thread", () => {
  let asked = '';

  it("posts the text then both images in the asker's thread, and the record names them", async () => {
    asked = (await w.hear(() => chat.say(chat.bob, 'Bản phát hành mới đã chạy chưa?'))).id;
    const first = await attach(issueId, 'release-home.png', 'image/png', PNG);
    const second = await attach(issueId, 'release-cart.jpg', 'image/jpeg', JPEG);
    const res = await post({
      text: RESULT,
      thread: asked,
      attachments: [issueImage(first), issueImage(second)],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const lines = w.threadLines(chat.rid, asked);
    expect(lines.map((l) => [l.text, l.file?.mime ?? null])).toEqual([
      [RESULT, null],
      ['', 'image/png'],
      ['', 'image/jpeg'],
    ]);
    expect(lines.every((l) => l.tmid === asked)).toBe(true);
    expect(lines[1]?.file?.bytes.equals(PNG)).toBe(true);
    expect(lines[2]?.file?.bytes.equals(JPEG)).toBe(true);
    // the uploader's file names stay out of the room; the room sees neutral ones
    expect(lines.slice(1).map((l) => l.file?.name)).toEqual(['image-1.png', 'image-2.jpg']);
    expect(res.body).toMatchObject({
      rid: chat.rid,
      thread: asked,
      attachments: [
        { attachmentId: first, messageId: lines[1]?.id },
        { attachmentId: second, messageId: lines[2]?.id },
      ],
    });
    const [act] = await rows<{ kind: string; attachments: unknown }>(sql`
      SELECT kind, input->'attachments' AS attachments FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND tool = 'master_post' AND thread = ${asked}`);
    expect(act).toEqual({
      kind: 'routed',
      attachments: [
        {
          target: 'issue',
          attachmentId: first,
          name: 'release-home.png',
          mime: 'image/png',
          size: PNG.length,
          messageId: lines[1]?.id,
        },
        {
          target: 'issue',
          attachmentId: second,
          name: 'release-cart.jpg',
          mime: 'image/jpeg',
          size: JPEG.length,
          messageId: lines[2]?.id,
        },
      ],
    });
  });

  it('posts an image after a top-level text of the team room, at its top level too', async () => {
    const shot = await attach(issueId, 'daily.png', 'image/png', PNG);
    const res = await post({ text: RESULT, rid: chat.rid2, attachments: [issueImage(shot)] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const top = chat.linesIn(chat.rid2).filter((l) => !l.tmid);
    expect(top.slice(-2).map((l) => [l.text, l.file?.mime ?? null])).toEqual([
      [RESULT, null],
      ['', 'image/png'],
    ]);
  });
});

describe('ISS-1024: an image the room cannot take is refused by name, nothing posted', () => {
  const nothingPosted = async (body: Record<string, unknown>, at: string, codes: string[]) => {
    const lines = allLines();
    const staged = chat.media.size;
    const res = await post(body);
    expect(
      refusalsOf(res).map((r) => [r.code, r.path]),
      JSON.stringify(res.body),
    ).toEqual(codes.map((c, i) => [c, `${at}${i}`]));
    expect(allLines(), 'no text, no image').toBe(lines);
    expect(chat.media.size, 'nothing uploaded to the chat server').toBe(staged);
    return res;
  };

  it('refuses an upload that is no image, naming it and the types a room takes', async () => {
    const notes = await attach(issueId, 'notes.txt', 'text/plain', Buffer.from('release notes'));
    const res = await nothingPosted(
      { text: RESULT, thread: 'unused', attachments: [issueImage(notes)] },
      '/attachments/',
      ['SUPPORT_POST_IMAGE_NOT_AN_IMAGE'],
    );
    expect(res.status).toBe(400);
    const [refusal] = refusalsOf(res);
    expect(refusal?.detail).toContain(notes);
    expect(refusal?.detail).toContain('image/png, image/jpeg, image/gif, image/webp');
    expect(refusal?.detail).toContain('Nothing was posted');
  });

  it('refuses an image over the room picture size, naming its size and the cap', async () => {
    const big = await attach(issueId, 'huge.png', 'image/png', PNG, 4_000_001);
    const res = await nothingPosted(
      { text: RESULT, rid: chat.rid2, attachments: [issueImage(big)] },
      '/attachments/',
      ['SUPPORT_POST_IMAGE_TOO_LARGE'],
    );
    expect(refusalsOf(res)[0]?.detail).toContain('4000001 bytes, over the 4000000');
  });

  it('refuses an upload of a project the caller cannot read, and an unknown one, each by name', async () => {
    const stranger = (await createTestUser({ verified: true })).id;
    const theirs = (await createTestProject(stranger)).id;
    const theirIssue = await createTestIssue(theirs, stranger, 1, {
      status: 'open',
      createdAt: new Date(),
    });
    const hidden = await attach(theirIssue.id, 'theirs.png', 'image/png', PNG);
    const fine = await attach(issueId, 'fine.png', 'image/png', PNG);
    const res = await nothingPosted(
      {
        text: RESULT,
        rid: chat.rid2,
        attachments: [
          issueImage(hidden),
          { target: 'comment', attachmentId: randomUUID() },
          issueImage(fine),
        ],
      },
      '/attachments/',
      ['SUPPORT_POST_IMAGE_UNREADABLE', 'SUPPORT_POST_IMAGE_UNKNOWN'],
    );
    expect(res.status).toBe(403);
    const [unreadable, unknown] = refusalsOf(res);
    expect(unreadable?.detail).toContain(`issue upload ${hidden}`);
    expect(unknown?.detail).toContain('no comment upload');
  });

  it('refuses a fifth image, and a feedback file, by the body shape', async () => {
    const one = await attach(issueId, 'one.png', 'image/png', PNG);
    const lines = allLines();
    const five = await post({
      text: RESULT,
      rid: chat.rid2,
      attachments: Array(5).fill(issueImage(one)),
    });
    expect(five.status).toBe(400);
    expect(JSON.stringify(five.body)).toContain('attachments');
    const feedback = await post({
      text: RESULT,
      rid: chat.rid2,
      attachments: [{ target: 'feedback', attachmentId: one }],
    });
    expect(feedback.status).toBe(400);
    expect(allLines()).toBe(lines);
  });

  it("refuses images at a users' room's top level as it refuses the text, posting nothing", async () => {
    const shot = await attach(issueId, 'top.png', 'image/png', PNG);
    const lines = allLines();
    const staged = chat.media.size;
    const res = await post({ text: RESULT, rid: chat.rid, attachments: [issueImage(shot)] });
    expect([res.status, refusalsOf(res)[0]?.code]).toEqual([409, 'SUPPORT_MASTER_POST_USERS_ROOM']);
    expect(allLines()).toBe(lines);
    expect(chat.media.size).toBe(staged);
  });

  it('posts nothing when the chat server takes no upload, naming the image', async () => {
    const shot = await attach(issueId, 'refused.png', 'image/png', PNG);
    const lines = allLines();
    chat.mediaRefused = true;
    try {
      const res = await post({ text: RESULT, rid: chat.rid2, attachments: [issueImage(shot)] });
      expect([res.status, refusalsOf(res)[0]?.code]).toEqual([503, 'SUPPORT_POST_IMAGE_UNPOSTED']);
      expect(refusalsOf(res)[0]?.detail).toContain('error-file-too-large');
      expect(allLines(), 'the text waits on its images').toBe(lines);
    } finally {
      chat.mediaRefused = false;
    }
  });
});
