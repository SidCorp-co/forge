// The reply screen holds a chat reply's tracker dates and statuses to what its turn read (chat mining
// 2026-10-07: a reply gave every completion date as 2024-05-15 with no tool call; the tracker held
// 2026-07-14/15). The database read is the one thing replaced: the issue row is what it held.

import { describe, expect, it, vi } from 'vitest';
import { facts } from './facts.js';

vi.mock('./gather.js', () => ({
  gatherFacts: async () =>
    facts({
      prefix: 'ISS',
      prefixes: ['ISS'],
      knownIssueSeqs: new Set([59]),
      issueRows: new Map([[59, { seq: 59, merged: true, status: 'closed' }]]),
    }),
}));

const { screenReplyAtDoor } = await import('./reply-screen.js');

const REPLY = 'Các việc đã xong:\n- ISS-59 hoàn thành ngày 2024-05-15.'; // i18n-allow: a production ask or reply replayed as the test case

describe('a chat reply states only the tracker facts its turn read', () => {
  it('refuses the invented date of a turn that called no tool', async () => {
    const verdict = await screenReplyAtDoor('web-chat-reply', {
      projectId: 'p-1',
      segments: [REPLY],
      toolCalls: [],
      progress: null,
      toolResults: [],
    });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.refusals.map((r) => r.rule)).toContain('tracker-facts-grounded');
  });

  it('passes the date and status the turn read', async () => {
    const verdict = await screenReplyAtDoor('web-chat-reply', {
      projectId: 'p-1',
      segments: ['- ISS-59 hoàn thành ngày 2026-07-15.'], // i18n-allow: a production ask or reply replayed as the test case
      toolCalls: [{ name: 'forge', arguments: '{"argv":["issue","ISS-59"]}' }],
      progress: null,
      toolResults: ['ISS-59 · closed · mergedAt 2026-07-15T03:12:00Z'],
    });
    expect(verdict.ok).toBe(true);
  });
});
