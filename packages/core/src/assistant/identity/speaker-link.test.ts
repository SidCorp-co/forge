// The refusal a person reads in a chat room when their chat account is not linked.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));

const { unlinkedMessage } = await import('./speaker-link.js');

const REF = {
  source: 'rocketchat',
  namespace: 'chat.example.co',
  externalId: 'RDJAkAgNzqJNttd8b',
  label: 'chuongld',
} as const;

describe('unlinkedMessage — written for the person who will read it', () => {
  const message = unlinkedMessage(REF);

  it('names the speaker it could not resolve', () => {
    expect(message).toContain('chuongld');
    expect(message).toContain('RDJAkAgNzqJNttd8b');
  });

  // The refusal this replaced opened with two REST paths and a JSON body, to a reader whose whole
  // surface is a message box, and never used the word "email" — which is the condition that actually
  // decides the link and the reason the one person who hit it was refused.
  it('states the condition that decides the link, in words', () => {
    expect(message).toMatch(/email/i);
    expect(message).toMatch(/same/i);
  });

  it('says why an account is needed at all, rather than only that one is missing', () => {
    expect(message).toMatch(/permission/i);
  });

  it('says the person confirms it themselves and an administrator cannot', () => {
    expect(message).toMatch(/administrator/i);
  });

  it('does not open with a REST path', () => {
    const firstSentence = message.split('. ')[0] ?? '';
    expect(firstSentence).not.toMatch(/POST |\/api\//);
  });

  it('still carries the route that exists, since no screen does', () => {
    expect(message).toContain('/speaker-links');
  });
});
