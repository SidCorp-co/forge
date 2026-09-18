// The refusal a person reads in a chat room when their chat account is not linked.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../config/env.js', () => ({
  env: { CORS_ORIGINS: 'https://forge.example.co,https://other.example.co' },
}));

const { unlinkedMessage } = await import('./speaker-link.js');
const { speakerLinkUrl } = await import('./link-url.js');

const REF = {
  source: 'rocketchat',
  namespace: 'chat.example.co',
  externalId: 'RDJAkAgNzqJNttd8b',
  label: 'chuongld',
} as const;
const PROJECT = '11111111-2222-4333-8444-555555555555';

describe('unlinkedMessage — written for the person who will read it', () => {
  const message = unlinkedMessage(REF, PROJECT);

  it('names the speaker it could not resolve', () => {
    expect(message).toContain('chuongld');
    expect(message).toContain('RDJAkAgNzqJNttd8b');
  });

  // The refusal this replaced never used the word "email", although a matching address is the
  // condition that decides the link and a mismatched one is why the first person to hit it was
  // refused (measured 2026-09-18).
  it('states the condition that decides the link, in words', () => {
    expect(message).toMatch(/email/i);
    expect(message).toMatch(/same/i);
  });

  // It opened with two REST paths and a JSON body, to a reader whose whole surface is a message box.
  it('does not open with a REST path', () => {
    expect(message.split('. ')[0] ?? '').not.toMatch(/POST |\/api\//);
  });

  // The first rewrite traded the paths for six sentences of prose, which is the same defect in
  // better clothes. Three is the budget: cause, condition, where to go.
  it('stays short enough to read in a chat client', () => {
    expect(message.split('. ').length).toBeLessThanOrEqual(3);
    // The URL is measured out: it is long, and unlike prose its length is the part doing the work.
    expect(message.replace(/https:\/\/\S+/, '').length).toBeLessThan(300);
  });

  it('sends the reader to a page rather than to an endpoint', () => {
    expect(message).toContain('https://forge.example.co/link-chat?');
    expect(message).not.toMatch(/POST /);
  });
});

describe('unlinkedMessage — degrading rather than lying', () => {
  it('names the endpoint when no project is known, instead of a broken link', () => {
    const message = unlinkedMessage(REF);
    expect(message).not.toContain('/link-chat');
    expect(message).toContain('/speaker-links');
  });
});

describe('speakerLinkUrl — one builder for every adapter', () => {
  it('carries the three things the page needs, whatever the source is', () => {
    const url = speakerLinkUrl({ projectId: PROJECT, source: 'telegram', externalId: 'abc 1' });
    const q = new URL(url as string).searchParams;
    expect(q.get('projectId')).toBe(PROJECT);
    expect(q.get('source')).toBe('telegram');
    expect(q.get('externalId')).toBe('abc 1');
  });

  it('takes the first CORS origin as this deployment own web address', () => {
    expect(speakerLinkUrl({ projectId: PROJECT, source: 'rocketchat', externalId: 'x' })).toMatch(
      /^https:\/\/forge\.example\.co\/link-chat\?/,
    );
  });
});
