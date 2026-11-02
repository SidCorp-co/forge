// REQ-30 BC-8/BC-9: a check that cannot run says so. When the read of the issues a reply names
// threw, issue-keys-exist, status-matches-the-row and the tracker-status grounding all returned
// nothing, so a reply naming an issue that does not exist, or a status the tracker does not hold,
// went out unchecked and nobody was told. The screen runs whole; the cited-issue read is made to throw.

import { beforeAll, describe, expect, it } from 'vitest';
import type { IssueStatus } from '../db/schema.js';
import { provideMessageReads } from '../messaging/reads.js';

const { screenedTurnReply: screenedTurn } = await import('./screened-reply.js');
/** What the screen lets out, or null where nothing goes out. */
const screenedTurnReply = async (a: Parameters<typeof screenedTurn>[0]) =>
  (await screenedTurn(a)).said;

beforeAll(() => {
  provideMessageReads({
    activeIssuePrefix: async () => 'ISS',
    heldIssuePrefixes: async () => [],
    citedIssues: async () => {
      throw new Error('connection terminated unexpectedly');
    },
    workflowDesign: async () => ({ kind: 'missing', flows: [] }),
    contractHolding: async () => ({ projectSlug: 'p', versions: [], named: false }),
    readsTechnical: async () => true,
    reportRunFrames: async () => [],
    agreedRecords: async () => [],
  });
});

const PROGRESS = {
  shipped: 1,
  closedUnshipped: 0,
  inFlight: 1,
  remaining: 1,
  total: 3,
  byStatus: {} as Record<IssueStatus, number>,
  computedAt: new Date('2026-10-08T15:00:00Z'),
};
const CALL = { name: 'forge_issues', arguments: '{"action":"list"}' };
const attempt = (reply: string) => ({
  conversationId: 'c-1',
  reply,
  terminal: 'done' as const,
  error: null,
  iterations: 1,
  toolCalls: [CALL],
  progress: PROGRESS,
});

async function screen(first: string, retries: string[]) {
  const asked: string[] = [];
  const message = await screenedTurnReply({
    door: 'web-chat-reply',
    projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
    askedIn: 'en',
    question: 'where does the login work stand?',
    first: attempt(first),
    retry: async (instruction) => {
      asked.push(instruction);
      const next = retries.shift();
      if (next === undefined) throw new Error('the test scripted no further attempt');
      return attempt(next);
    },
    setPhase: () => undefined,
    offeredTools: ['forge_issues'],
    toolResults: () => ['{"issues":[]}'],
  });
  return { text: message?.text ?? null, asked };
}

describe('a reply naming issues the screen could not read', () => {
  it('is held whole, and core says nothing in its place (ISS-875)', async () => {
    const draft = 'ISS-9999 is merged and closed.';
    const out = await screen(draft, [draft]);
    expect(out.asked).toHaveLength(1);
    expect(out.text).toBeNull();
  });

  it('goes out once the rewrite names no issue', async () => {
    const out = await screen('ISS-9999 is merged and closed.', [
      'The login work is merged; I could not look up its issue just now.',
    ]);
    expect(out.asked[0]).toContain('could not be read from the tracker');
    expect(out.text).toBe('The login work is merged; I could not look up its issue just now.');
  });

  it('that names no issue is not touched by the failing read', async () => {
    const out = await screen('Most of the work is done and a few items are still open.', []);
    expect(out.asked).toEqual([]);
    expect(out.text).toBe('Most of the work is done and a few items are still open.');
  });
});
