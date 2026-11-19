/**
 * One attachment deleted from a feedback item (ISS-1327, FB-737): adminhub-fe FB-29 carried a
 * screenshot showing a secret key, and the only deletion an item had, its reporter's whole data,
 * would have taken the item's text and every other picture with it. One attachment goes by its id,
 * with its bytes; the item's other attachments and text stay; why is written on the item's record as
 * an internal note naming the file. The item's writer may, as may a holder of feedback.redact; anyone
 * else, an id the item does not hold and an empty reason are refused by name, and nothing goes. The
 * MCP door's twin is project_feedback detach.
 *
 * @direct-test-of packages/core/src/feedback/attachment-delete.ts
 * @direct-test-of packages/core/src/feedback/attachment-delete-routes.ts
 * @direct-test-of packages/core/src/mcp/feedback-tool.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getStorage } from '../../src/integrations/index.js';
import { api, type Body, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestFeedback,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { feedback, type World, world } from '../helpers/forecast-world.js';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let w: World;
let memberId: string;
let member: string;
const base = () => `/api/projects/${w.projectId}/feedback`;

async function attach(token: string, fb: string, name: string): Promise<string> {
  const res = await api(token, 'POST', `${base()}/${fb}/attachments`, {
    name,
    mime: 'image/png',
    contentBase64: PNG,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.attachmentId as string;
}

const names = async (fb: string): Promise<string[]> => {
  const read = await api(w.token, 'GET', `${base()}/${fb}`);
  expect(read.status).toBe(200);
  return ((read.body.feedback as Body).attachments as Body[]).map((a) => String(a.name)).sort();
};

const codes = (b: Body): string[] =>
  ((b.error as Body | undefined)?.refusals as { code: string }[] | undefined)?.map((r) => r.code) ??
  [];

const detach = (token: string, fb: string, id: string, reason: string) =>
  api(token, 'DELETE', `${base()}/${fb}/attachments/${id}`, { reason });

beforeAll(async () => {
  w = await world();
  await feedback(w);
  const m = await createTestUser({ verified: true });
  memberId = m.id;
  await addProjectMember(w.projectId, m.id, 'member');
  member = await userToken(m.id);
  // FB-2 is the member's own
  await createTestFeedback(w.projectId, memberId, 2);
}, 180_000);

describe('one attachment of a feedback item deleted by its id (ISS-1327)', () => {
  it('deletes the one named with its bytes, keeps the rest and the text, and writes why on the record', async () => {
    const full = await attach(w.token, 'FB-1', 'form-filled.png');
    await attach(w.token, 'FB-1', 'thumb-a.png');
    await attach(w.token, 'FB-1', 'order-page.png');
    const before = await api(w.token, 'GET', `${base()}/FB-1`);
    const title = (before.body.feedback as Body).title;

    // planted on today's code: no such route, so nothing is deleted
    const res = await detach(w.token, 'FB-1', full, 'the screenshot shows a test account key');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await names('FB-1')).toEqual(['order-page.png', 'thumb-a.png']);
    expect((res.body.feedback as Body).title).toBe(title);
    const gone = await api(w.token, 'GET', `${base()}/FB-1/attachments/${full}`);
    expect(gone.status).toBe(404);
    const notes = await rows<{ audience: string; body: string; sent_by: string }>(sql`
      SELECT m.audience, m.body, m.sent_by FROM feedback_messages m JOIN feedback f ON f.id = m.feedback_id
       WHERE f.project_id = ${w.projectId}::uuid AND f.fb_seq = 1`);
    expect(notes).toEqual([
      {
        audience: 'internal',
        body: `Attachment "form-filled.png" (${full}) deleted: the screenshot shows a test account key`,
        sent_by: w.userId,
      },
    ]);
  });

  it('refuses by name an id the item does not hold, an empty reason, and a member who neither wrote it nor holds feedback.redact', async () => {
    const kept = await attach(w.token, 'FB-1', 'kept.png');
    const unknown = await detach(w.token, 'FB-1', randomUUID(), 'gone');
    expect(codes(unknown.body), JSON.stringify(unknown.body)).toEqual([
      'FEEDBACK_ATTACHMENT_UNKNOWN',
    ]);
    const blank = await detach(w.token, 'FB-1', kept, '  ');
    expect(codes(blank.body), JSON.stringify(blank.body)).toEqual([
      'FEEDBACK_ATTACHMENT_REASON_REQUIRED',
    ]);
    const other = await detach(member, 'FB-1', kept, 'not mine to delete');
    expect(other.status, JSON.stringify(other.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(other.body)).toContain('feedback.redact');
    expect(await names('FB-1')).toContain('kept.png');
  });

  // cleanup 21284cd0: a storage delete that failed was logged and answered 200 deleted, so a picture
  // showing a secret was reported gone while its bytes stayed
  it('refuses by name while storage keeps the file, keeping the attachment so a retry deletes it', async () => {
    const secret = await attach(w.token, 'FB-1', 'secret-key.png');
    const notes = async () =>
      (
        await rows<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM feedback_messages m JOIN feedback f ON f.id = m.feedback_id
           WHERE f.project_id = ${w.projectId}::uuid AND f.fb_seq = 1`)
      )[0]?.n;
    const before = await notes();
    const down = vi.spyOn(getStorage(), 'delete').mockRejectedValueOnce(new Error('bucket down'));
    const kept = await detach(w.token, 'FB-1', secret, 'shows a secret key');
    down.mockRestore();
    expect(kept.status, JSON.stringify(kept.body)).toBe(503);
    expect(codes(kept.body)).toEqual(['FEEDBACK_ATTACHMENT_STORAGE_KEPT']);
    expect(await names('FB-1')).toContain('secret-key.png');
    expect((await api(w.token, 'GET', `${base()}/FB-1/attachments/${secret}`)).status).toBe(200);
    expect(await notes()).toBe(before);

    const again = await detach(w.token, 'FB-1', secret, 'shows a secret key');
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await names('FB-1')).not.toContain('secret-key.png');
  });

  it('lets the item’s writer delete one of its attachments, and the MCP twin delete by id', async () => {
    const own = await attach(member, 'FB-2', 'mine.png');
    const res = await detach(member, 'FB-2', own, 'attached the wrong screenshot');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await names('FB-2')).toEqual([]);

    const twin = await attach(w.token, 'FB-1', 'twin.png');
    const pat = await patToken(w.userId, [w.projectId]);
    const called = await api(
      pat,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'project_feedback',
          arguments: {
            action: 'detach',
            projectId: w.projectId,
            feedback: 'FB-1',
            attachment: twin,
            reason: 'shows a password',
          },
        },
      },
      { accept: 'application/json, text/event-stream' },
    );
    expect(called.status, JSON.stringify(called.body)).toBe(200);
    const result = (called.body as { result: { isError?: boolean } }).result;
    expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
    expect(await names('FB-1')).not.toContain('twin.png');
  });
});
