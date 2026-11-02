/**
 * A file reaches an EXISTING feedback item (ISS-879, from FB-474 / agenfold FB-37): the approved
 * mockups of an item could not be attached once it was filed, so the issues it became parked asking
 * for them. Over REST and over the MCP door a file attaches with its name, type, size and an optional
 * `approved_design` label; the answer names its id; the item's read lists it with who attached it and
 * when; forge_uploads fetches it by that id; and each wrong attach is refused by name.
 *
 * @direct-test-of packages/core/src/feedback/attachments.ts
 * @direct-test-of packages/core/src/mcp/feedback-tool.ts
 * @direct-test-of packages/core/src/uploads/tool.ts
 * @direct-test-of packages/core/src/uploads/attachment-lookup.ts
 */

import { FEEDBACK_LIMITS } from '@forge/contracts/feedback';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, type Body, patToken, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { feedback, type World, world } from '../helpers/forecast-world.js';

// a 1x1 PNG: its bytes are sniffed, so the type is the content's, not only the name's
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG, 'base64');

interface Called {
  isError: boolean;
  text: string;
  body: Body;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

async function call(token: string, name: string, args: Record<string, unknown>): Promise<Called> {
  const res = await api(
    token,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = (res.body as { result: { content: Called['content']; isError?: boolean } }).result;
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  let body: Body = {};
  try {
    body = JSON.parse(result.content[0]?.text ?? '') as Body;
  } catch {}
  const structured = (res.body as { result: { structuredContent?: Body } }).result
    .structuredContent;
  return {
    isError: result.isError === true,
    text,
    body: structured ?? body,
    content: result.content,
  };
}

const refusalCodes = (b: Body) =>
  ((b.error as Body | undefined)?.refusals as { code: string }[] | undefined)?.map((r) => r.code) ??
  [];

// one project and one item for the file: the refusals below count the files the attaches above wrote
let w: World;
let pat: string;
let viewerJwt: string;
let viewerPat: string;
const fb = 'FB-1';
const base = () => `/api/projects/${w.projectId}/feedback`;

beforeAll(async () => {
  w = await world();
  pat = await patToken(w.userId, [w.projectId]);
  const viewer = await createTestUser({ verified: true });
  await addProjectMember(w.projectId, viewer.id, 'viewer');
  viewerJwt = await userToken(viewer.id);
  viewerPat = await patToken(viewer.id, [w.projectId]);
  await feedback(w);
}, 180_000);

describe('a file attached to an existing feedback item (ISS-879)', () => {
  it('attaches over REST with its label, answers its id, and the item lists it', async () => {
    const res = await api(w.token, 'POST', `${base()}/${fb}/attachments`, {
      name: 'checkout-approved.png',
      mime: 'image/png',
      contentBase64: PNG,
      label: 'approved_design',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.attachmentId as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const read = await api(w.token, 'GET', `${base()}/${fb}`);
    expect(read.status).toBe(200);
    const listed = ((read.body.feedback as Body).attachments as Body[]).find((a) => a.id === id);
    expect(listed).toMatchObject({
      id,
      name: 'checkout-approved.png',
      mime: 'image/png',
      size: PNG_BYTES.length,
      label: 'approved_design',
      uploadedBy: w.userId,
      createdAt: expect.any(String),
      url: `${base()}/${fb}/attachments/${id}`,
    });

    const bytes = await api(w.token, 'GET', `${base()}/${fb}/attachments/${id}`);
    expect(bytes.status).toBe(200);
  });

  it('marks nothing where no label is sent', async () => {
    const res = await api(w.token, 'POST', `${base()}/${fb}/attachments`, {
      name: 'notes.txt',
      mime: 'text/plain',
      contentBase64: Buffer.from('the header overlaps the logo').toString('base64'),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const listed = ((res.body.feedback as Body).attachments as Body[]).find(
      (a) => a.id === res.body.attachmentId,
    );
    expect(listed?.label).toBeNull();
  });

  it('attaches over MCP, lists it on get, and forge_uploads fetches it by its id', async () => {
    const attached = await call(pat, 'project_feedback', {
      action: 'attach',
      projectId: w.projectId,
      feedback: fb,
      name: 'cart-approved.png',
      mime: 'image/png',
      contentBase64: PNG,
      label: 'approved_design',
    });
    expect(attached.isError, attached.text).toBe(false);
    const id = attached.body.attachmentId as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(attached.body.attachment).toMatchObject({
      id,
      name: 'cart-approved.png',
      mime: 'image/png',
      size: PNG_BYTES.length,
      label: 'approved_design',
      at: expect.any(String),
    });

    const got = await call(pat, 'project_feedback', {
      action: 'get',
      projectId: w.projectId,
      feedback: fb,
    });
    expect(got.isError, got.text).toBe(false);
    const rows = (got.body.feedback as Body).attachments as Body[];
    expect(rows.map((r) => r.name)).toEqual([
      'checkout-approved.png',
      'notes.txt',
      'cart-approved.png',
    ]);
    expect(rows.find((r) => r.id === id)).toMatchObject({
      label: 'approved_design',
      by: expect.any(String),
      at: expect.any(String),
    });

    const fetched = await call(pat, 'forge_uploads', {
      action: 'fetch',
      data: { target: 'feedback', attachmentId: id },
    });
    expect(fetched.isError, fetched.text).toBe(false);
    const image = fetched.content.find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image?.data ?? '', 'base64').equals(PNG_BYTES)).toBe(true);

    const meta = fetched.body;
    expect(meta).toMatchObject({ attachmentId: id, name: 'cart-approved.png', mime: 'image/png' });
    const download = await api(null, 'GET', meta.downloadUrl as string);
    expect(download.status).toBe(200);
  });

  it('is found, described and called through the forge_find / forge_describe / forge_call doors', async () => {
    const found = await call(pat, 'forge_find', { query: 'attach a file to a feedback item' });
    expect(found.body.actions as string[]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^project_feedback\.attach/)]),
    );
    const described = await call(pat, 'forge_describe', { action: 'project_feedback.attach' });
    expect(described.isError, described.text).toBe(false);
    const input = described.body.input as Body;
    expect(input.required).toEqual(
      expect.arrayContaining(['feedback', 'name', 'mime', 'contentBase64']),
    );
    expect(Object.keys(input.properties as Body)).toEqual(
      expect.arrayContaining(['label', 'redacted']),
    );

    const called = await call(pat, 'forge_call', {
      action: 'project_feedback.attach',
      args: {
        projectId: w.projectId,
        feedback: fb,
        name: 'door.png',
        mime: 'image/png',
        contentBase64: PNG,
        label: 'approved_design',
      },
    });
    expect(called.isError, called.text).toBe(false);
    expect(called.body.attachmentId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('an attach refused by name, writing nothing (ISS-879)', () => {
  it('refuses a fetch of a feedback attachment id no item holds, by name', async () => {
    const fetched = await call(pat, 'forge_uploads', {
      action: 'fetch',
      data: { target: 'feedback', attachmentId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(fetched.isError).toBe(true);
    expect(fetched.text).toMatch(/not found/);
  });

  it('refuses an item the project does not hold, by name', async () => {
    const res = await api(w.token, 'POST', `${base()}/FB-999/attachments`, {
      name: 'a.png',
      mime: 'image/png',
      contentBase64: PNG,
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(String(res.body.message)).toContain('FB-999');

    const mcp = await call(pat, 'project_feedback', {
      action: 'attach',
      projectId: w.projectId,
      feedback: 'FB-999',
      name: 'a.png',
      mime: 'image/png',
      contentBase64: PNG,
    });
    expect(mcp.isError).toBe(true);
    expect(mcp.text).toContain('FB-999');
  });

  it('refuses whoever may not comment on the item, at both doors, writing nothing', async () => {
    const res = await api(viewerJwt, 'POST', `${base()}/${fb}/attachments`, {
      name: 'a.png',
      mime: 'image/png',
      contentBase64: PNG,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('PERMISSION_FORBIDDEN');

    const mcp = await call(viewerPat, 'project_feedback', {
      action: 'attach',
      projectId: w.projectId,
      feedback: fb,
      name: 'a.png',
      mime: 'image/png',
      contentBase64: PNG,
    });
    expect(mcp.isError).toBe(true);
    expect(mcp.text).toContain('PERMISSION_FORBIDDEN');

    const read = await api(w.token, 'GET', `${base()}/${fb}`);
    expect((read.body.feedback as Body).attachments as Body[]).toHaveLength(4);
  });

  it('refuses a type the attachment allow-list does not keep', async () => {
    const res = await api(w.token, 'POST', `${base()}/${fb}/attachments`, {
      name: 'setup.exe',
      mime: 'application/x-msdownload',
      contentBase64: Buffer.from('MZ\x90\x00not a picture').toString('base64'),
    });
    expect(res.status).toBe(422);
    expect(refusalCodes(res.body)).toEqual(['MIME_NOT_ALLOWED']);
    expect(res.body.code).toBe('MIME_NOT_ALLOWED');
  });

  it('refuses a file over the attachment limit', async () => {
    const big = Buffer.alloc(FEEDBACK_LIMITS.attachmentBytes + 1, 0);
    PNG_BYTES.copy(big);
    const res = await api(w.token, 'POST', `${base()}/${fb}/attachments`, {
      name: 'huge.png',
      mime: 'image/png',
      contentBase64: big.toString('base64'),
    });
    expect(res.status).toBe(422);
    expect(refusalCodes(res.body)).toEqual(['FILE_TOO_LARGE']);
  });

  it('refuses a file that decodes to no bytes', async () => {
    const res = await api(w.token, 'POST', `${base()}/${fb}/attachments`, {
      name: 'empty.png',
      mime: 'image/png',
      contentBase64: '====',
    });
    expect(res.status).toBe(422);
    expect(refusalCodes(res.body)).toEqual(['EMPTY_FILE']);

    const mcp = await call(pat, 'project_feedback', {
      action: 'attach',
      projectId: w.projectId,
      feedback: fb,
      name: 'empty.png',
      mime: 'image/png',
      contentBase64: '====',
    });
    expect(mcp.isError).toBe(true);
    expect(mcp.text).toContain('EMPTY_FILE');
  });

  it('refuses a label it does not know, by the field', async () => {
    const res = await api(w.token, 'POST', `${base()}/${fb}/attachments`, {
      name: 'a.png',
      mime: 'image/png',
      contentBase64: PNG,
      label: 'final',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('label');
  });

  it('wrote no file for any refused attach', async () => {
    const read = await api(w.token, 'GET', `${base()}/${fb}`);
    expect((read.body.feedback as Body).attachments as Body[]).toHaveLength(4);
  });
});
