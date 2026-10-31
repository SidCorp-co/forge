import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../integrations/index.js', () => ({
  getStorage: () => ({
    get: async () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    },
  }),
  isEnoent: (err: unknown) => (err as { code?: string } | null)?.code === 'ENOENT',
}));

const { errorHandler } = await import('../middleware/error.js');
const { sendStoredAttachment } = await import('../lib/attachment-headers.js');
const { readAttachmentBytes } = await import('./attachment-lookup.js');

const file = { path: 'a/b.png', mime: 'image/png', name: 'b.png' };

function app() {
  const a = new Hono();
  a.get('/stored', (c) =>
    sendStoredAttachment(c, file, async () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    }),
  );
  a.get('/ticket', (c) =>
    sendStoredAttachment(c, file, () => readAttachmentBytes(file as never), { download: true }),
  );
  a.onError(errorHandler as never);
  return a;
}

type Body = { code: string; error: { code: string; refusals: { code: string }[] } };

describe.each(['/stored', '/ticket'])('GET %s: a file gone from storage', (path) => {
  it('is ATTACHMENT_FILE_MISSING, 404, in the envelope, never a 410', async () => {
    const res = await app().request(path);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as Body;
    expect(body.error.code).toBe('ATTACHMENT_FILE_MISSING');
    expect(body.code).toBe('ATTACHMENT_FILE_MISSING');
    expect(body.error.refusals[0]?.code).toBe('ATTACHMENT_FILE_MISSING');
  });
});

describe('a storage fault that is not a missing file', () => {
  it('is not turned into a refusal', async () => {
    const a = new Hono();
    a.get('/x', (c) =>
      sendStoredAttachment(c, file, async () => {
        throw new Error('disk on fire');
      }),
    );
    a.onError(errorHandler as never);
    expect((await a.request('/x')).status).toBe(500);
  });
});
