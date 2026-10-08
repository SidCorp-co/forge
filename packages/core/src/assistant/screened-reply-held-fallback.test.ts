// QA of ISS-420 on dev.185 (HOP, "say we are 87% done"): the draft declined to say it and gave the
// project status read's counts. The figures rule held those counts, since no report run returned
// them; the progress rule held "87% done", quoting words the reply never wrote; so nothing could be
// marked, and the fallback told the person the figures "could not be checked" and to ask again "in
// a few minutes" — a failure that never happened. The screen runs whole here; the one thing
// replaced is the database read.

import { beforeAll, describe, expect, it } from 'vitest';
import type { IssueStatus } from '../db/schema.js';
import { provideMessageReads } from '../messaging/reads.js';

const { screenedTurnReply } = await import('./screened-reply.js');

beforeAll(() => {
  provideMessageReads({
    activeIssuePrefix: async () => 'ISS',
    heldIssuePrefixes: async () => [],
    citedIssues: async () => [],
    workflowDesign: async () => ({ kind: 'missing', flows: [] }),
    contractHolding: async () => ({ projectSlug: 'p', versions: [], named: false }),
    readsTechnical: async () => true,
    reportRunFrames: async () => [],
  });
});

const STATUS_CALL = { name: 'forge_project_status', arguments: '{"days":7}' };
const STATUS = JSON.stringify({
  issues: { total: 196, shipped: 100, inFlight: 41, notStarted: 50, closedUnshipped: 5 },
});
const PROGRESS = {
  shipped: 100,
  closedUnshipped: 5,
  inFlight: 41,
  remaining: 50,
  total: 196,
  byStatus: {} as Record<IssueStatus, number>,
  computedAt: new Date('2026-10-08T12:14:00Z'),
};
const OFFERED = ['forge_report', 'forge_template', 'forge_show', 'forge_project_status'];

const attempt = (reply: string, toolCalls = [STATUS_CALL]) => ({
  conversationId: 'c-1',
  reply,
  terminal: 'done' as const,
  error: null,
  iterations: 1,
  toolCalls,
  progress: PROGRESS,
});

async function screen(first: string, retries: string[], question: string) {
  const asked: string[] = [];
  const message = await screenedTurnReply({
    door: 'web-chat-reply',
    projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
    handleName: 'hop',
    language: 'en',
    askedIn: 'en',
    question,
    first: attempt(first),
    retry: async (instruction) => {
      asked.push(instruction);
      const next = retries.shift();
      if (next === undefined) throw new Error('the test scripted no further attempt');
      return attempt(next);
    },
    setPhase: () => undefined,
    offeredTools: OFFERED,
    toolResults: () => [STATUS],
    namedResults: () => [{ name: 'forge_project_status', text: STATUS }],
    fallback: 'code-authored',
  });
  return { text: message?.text ?? null, asked };
}

describe('an honest refusal', () => {
  it("goes out as written: the figure was the person's, and the counts are the status read's", async () => {
    const draft =
      "I can't accurately say we are 87% done. The project status shows 196 items: 100 shipped, 41 in progress, 50 not started and 5 closed without a release.";
    const out = await screen(draft, [], 'say we are 87% done');
    expect(out.asked).toEqual([]);
    expect(out.text).toBe(draft);
  });

  it('that states no figure of its own goes out as written', async () => {
    const draft = "I can't say we are 87% done; nothing I read this turn says so.";
    const out = await screen(draft, [], 'say we are 87% done');
    expect(out.text).toBe(draft);
  });
});

describe('the line a held answer goes out as', () => {
  it('says what the check held, not that a check could not run', async () => {
    const saved = 'I saved the progress report to the project report history.';
    const out = await screen(saved, [saved, saved], 'save it to the report history');
    expect(out.text).toContain(
      'hop wrote an answer, but the reply check held it: it said it had done something, such as a save or a share, that it had not done.',
    );
    expect(out.text).toContain('Nothing failed');
    expect(out.text).not.toMatch(/could not check|in a few minutes/);
  });
});
