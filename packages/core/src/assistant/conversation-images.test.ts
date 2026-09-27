/**
 * The two pure halves of the web door's vision path: which ids a send may not
 * use, and which `ref` a resolver will answer for.
 */

import { describe, expect, it } from 'vitest';
import { foreignAttachmentIds, imagesFromAttachments } from './conversation-images.js';

const ROOM = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function ref(id: string, conversationId = ROOM) {
  return {
    id,
    conversationId,
    name: `${id}.png`,
    mime: 'image/png',
    size: 10,
    url: `/api/conversations/${conversationId}/attachments/${id}/download`,
  };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('which ids a send may not use', () => {
  it('names the id the room does not hold, not how many there were', () => {
    expect(foreignAttachmentIds([A, B], [ref(A)])).toEqual([B]);
  });

  it('names nothing where the room holds them all', () => {
    expect(foreignAttachmentIds([A, B], [ref(A), ref(B)])).toEqual([]);
  });

  it('names every one of them where the room holds none', () => {
    expect(foreignAttachmentIds([A, B], [])).toEqual([A, B]);
  });

  it('is empty where the send named no attachment at all', () => {
    expect(foreignAttachmentIds([], [])).toEqual([]);
  });
});

describe('what a message stores for a staged file', () => {
  it('stores the reference and never the bytes', () => {
    expect(imagesFromAttachments([ref(A)])).toEqual([
      {
        name: `${A}.png`,
        mime: 'image/png',
        ref: `/api/conversations/${ROOM}/attachments/${A}/download`,
      },
    ]);
  });

  it('keeps the order the sender staged them in', () => {
    expect(imagesFromAttachments([ref(B), ref(A)]).map((i) => i.name)).toEqual([
      `${B}.png`,
      `${A}.png`,
    ]);
  });
});

describe('the resolver, on a ref it should not answer for', () => {
  it('reads nothing for a ref belonging to another room', async () => {
    const { makeConversationImageResolver } = await import('./conversation-images.js');
    const resolve = makeConversationImageResolver(ROOM);
    const stranger = await resolve({
      name: 'x.png',
      mime: 'image/png',
      ref: `/api/conversations/${OTHER}/attachments/${A}/download`,
    });
    expect(stranger).toBeNull();
  });

  it("reads nothing for another venue's ref shape", async () => {
    const { makeConversationImageResolver } = await import('./conversation-images.js');
    const resolve = makeConversationImageResolver(ROOM);
    expect(
      await resolve({ name: 'x.png', mime: 'image/png', ref: 'rocketchat/file/abc' }),
    ).toBeNull();
  });

  it('reads nothing for a ref whose id is not one', async () => {
    const { makeConversationImageResolver } = await import('./conversation-images.js');
    const resolve = makeConversationImageResolver(ROOM);
    expect(
      await resolve({
        name: 'x.png',
        mime: 'image/png',
        ref: `/api/conversations/${ROOM}/attachments/../../secrets/download`,
      }),
    ).toBeNull();
  });
});
