import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractMessageImages, extractMessageText, fetchAttachmentBytes } from './rest-client.js';

const AUTH = { serverUrl: 'https://chat.example.com', authToken: 't', userId: 'u' };
const BASE = AUTH.serverUrl;

describe('extractMessageText', () => {
  it('absolutizes a root-relative attachment link so it survives leaving the room', () => {
    const text = extractMessageText(
      { msg: '', attachments: [{ title: 'Task #12608', title_link: '/tasks?task=12608' }] },
      BASE,
    );
    expect(text).toBe('Task #12608 (https://chat.example.com/tasks?task=12608)');
  });

  it('leaves an already-absolute link alone', () => {
    const text = extractMessageText(
      { attachments: [{ title: 'T', title_link: 'https://hub.example.com/t/1' }] },
      BASE,
    );
    expect(text).toContain('(https://hub.example.com/t/1)');
  });
});

describe('extractMessageImages', () => {
  it('builds an absolute credentialed ref from the top-level file', () => {
    const images = extractMessageImages(
      { file: { _id: 'smSSrnkHfaNfojakW', name: 'Clipboard - Aug 31.png', type: 'image/png' } },
      BASE,
    );
    expect(images).toEqual([
      {
        name: 'Clipboard - Aug 31.png',
        mime: 'image/png',
        ref: 'https://chat.example.com/file-upload/smSSrnkHfaNfojakW/Clipboard%20-%20Aug%2031.png',
      },
    ]);
  });

  it('reads the attachments[] spelling when the server omits file[]', () => {
    const images = extractMessageImages(
      {
        attachments: [
          { title: 'shot.png', image_url: '/file-upload/abc/shot.png', image_type: 'image/PNG' },
        ],
      },
      BASE,
    );
    expect(images).toHaveLength(1);
    expect(images[0]?.mime).toBe('image/png');
    expect(images[0]?.ref).toBe('https://chat.example.com/file-upload/abc/shot.png');
  });

  it('does not double-count an upload that appears in both places', () => {
    const images = extractMessageImages(
      {
        file: { _id: 'abc', name: 'shot.png', type: 'image/png' },
        attachments: [{ image_url: '/file-upload/abc/shot.png', image_type: 'image/png' }],
      },
      BASE,
    );
    expect(images).toHaveLength(1);
  });

  it('skips a non-image upload nothing downstream can use', () => {
    expect(
      extractMessageImages({ file: { _id: 'a', name: 'spec.pdf', type: 'application/pdf' } }, BASE),
    ).toEqual([]);
  });

  it('returns nothing for a plain text message', () => {
    expect(extractMessageImages({}, BASE)).toEqual([]);
  });
});

describe('fetchAttachmentBytes', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(impl: (url: string, init: RequestInit) => Response) {
    const spy = vi.fn((url: unknown, init: unknown) =>
      Promise.resolve(impl(String(url), init as RequestInit)),
    );
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('sends the bot credential and follows the storage redirect', async () => {
    const spy = stubFetch(() => new Response(Buffer.from('PNGBYTES'), { status: 200 }));
    const bytes = await fetchAttachmentBytes(AUTH, `${BASE}/file-upload/a/b.png`, 1000);
    expect(bytes?.toString()).toBe('PNGBYTES');
    const init = spy.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers['X-Auth-Token']).toBe('t');
    expect(init.headers['X-User-Id']).toBe('u');
    expect(init.redirect).toBe('follow');
  });

  it('rejects on the declared content-length before reading the body', async () => {
    const spy = stubFetch(
      () => new Response(Buffer.alloc(10), { status: 200, headers: { 'content-length': '9999' } }),
    );
    expect(await fetchAttachmentBytes(AUTH, `${BASE}/file-upload/a/b.png`, 1000)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns null on a 403 rather than throwing into the turn', async () => {
    stubFetch(() => new Response('forbidden', { status: 403 }));
    expect(await fetchAttachmentBytes(AUTH, `${BASE}/file-upload/a/b.png`, 1000)).toBeNull();
  });

  it('returns null on an empty body', async () => {
    stubFetch(() => new Response(Buffer.alloc(0), { status: 200 }));
    expect(await fetchAttachmentBytes(AUTH, `${BASE}/file-upload/a/b.png`, 1000)).toBeNull();
  });
});
