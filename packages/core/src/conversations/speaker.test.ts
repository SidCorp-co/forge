/**
 * The linked speaker of a window (ISS-1034): the newest person message's
 * linked author, never the principal, and null when that author is unlinked.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../db/client.js', () => ({ db: {} }));

const { linkedSpeakerOf } = await import('./speaker.js');

const msg = (over: Record<string, unknown>) =>
  ({
    id: 'm',
    conversationId: 'c',
    seq: 0,
    role: 'user',
    authorUserId: null,
    authorLabel: null,
    authorKey: null,
    externalId: null,
    content: '',
    images: [],
    blocks: null,
    deliveryProof: null,
    silenceReason: null,
    createdAt: new Date(0),
    ...over,
  }) as never;

describe('linkedSpeakerOf', () => {
  it('is the newest person message’s linked author, skipping the assistant’s reply', () => {
    const out = linkedSpeakerOf([
      msg({ seq: 0, authorUserId: 'alice' }),
      msg({ seq: 1, authorUserId: 'bob', authorLabel: '@bob' }),
      msg({ seq: 2, role: 'assistant', authorUserId: 'handle' }),
    ]);
    expect(out).toEqual({ userId: 'bob', label: '@bob' });
  });

  it('is null for an unlinked newest author, carrying the label for the reader (criterion 62)', () => {
    const out = linkedSpeakerOf([
      msg({ seq: 0, authorUserId: 'alice' }),
      msg({ seq: 1, authorUserId: null, authorKey: 'rc:u42' }),
    ]);
    expect(out).toEqual({ userId: null, label: 'rc:u42' });
  });

  it('is null with no label when nobody has spoken', () => {
    expect(linkedSpeakerOf([])).toEqual({ userId: null, label: null });
    expect(linkedSpeakerOf([msg({ role: 'assistant' })])).toEqual({ userId: null, label: null });
  });
});
