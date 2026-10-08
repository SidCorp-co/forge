// QA on forge-dev 2026-10-08 13:43Z (REQ-32's BA room): asked to "draft revision r2 of REQ-32", the
// BA turn read the requirement, checked similarity and proposed the revision through ba_suggest, and
// the person got "could not check the project's figures" instead of an answer. The screen held the
// true "drafted r2 of REQ-32": the creation-claims rule knew only forge_requirement_draft and
// forge_requirement_revise as a requirement write, and the BA door's write is ba_suggest, so no
// rewrite could pass. The screen runs whole here; the one thing replaced is the database read.

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
    agreedRecords: async () => [],
  });
});

const QUESTION =
  'Please draft revision r2 of REQ-32 with these criterion changes, keep every other criterion as it is. BC-15 (new): a progress report reads as an analysis. Why: owner, 2026-10-08, rated the share-link report 1/10.';
const OFFERED = [
  'ba_read_requirement',
  'ba_read_issue',
  'ba_find_similar',
  'ba_suggest',
  'ba_ask_clarification',
  'ba_send_questionnaire',
  'ba_draw_mockup',
];
const READ = '{"key":"REQ-32","currentRevision":1}';
const SIMILAR = '{"status":"ok","similar":[{"key":"REQ-32","similarity":0.842}]}';
const SUGGESTED = '{"suggestion":{"id":"c7ab256a","kind":"revision_diff","status":"proposed"}}';
const PROGRESS = {
  shipped: 300,
  closedUnshipped: 5,
  inFlight: 41,
  remaining: 50,
  total: 396,
  byStatus: {} as Record<IssueStatus, number>,
  computedAt: new Date('2026-10-08T13:43:00Z'),
};

type Call = { name: string; arguments: string; isError?: boolean };
const calls = (suggest: Partial<Call> = {}): Call[] => [
  { name: 'ba_read_requirement', arguments: '{}' },
  { name: 'ba_find_similar', arguments: '{"text":"progress report analysis"}' },
  { name: 'ba_suggest', arguments: '{"kind":"revision_diff","baseRevision":1}', ...suggest },
];

async function screen(
  first: string,
  retries: string[],
  opts: { suggest?: Partial<Call>; progress?: typeof PROGRESS | null } = {},
) {
  const toolCalls = calls(opts.suggest);
  const progress = opts.progress === undefined ? PROGRESS : opts.progress;
  const attempt = (reply: string) => ({
    conversationId: 'c-1',
    reply,
    terminal: 'done' as const,
    error: null,
    iterations: 1,
    toolCalls,
    progress,
  });
  const asked: string[] = [];
  const message = await screenedTurnReply({
    door: 'web-chat-reply',
    projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
    handleName: 'forge',
    language: 'en',
    askedIn: 'en',
    question: QUESTION,
    first: attempt(first),
    retry: async (instruction) => {
      asked.push(instruction);
      const next = retries.shift();
      if (next === undefined) throw new Error('the test scripted no further attempt');
      return attempt(next);
    },
    setPhase: () => undefined,
    offeredTools: OFFERED,
    toolResults: () => [READ, SIMILAR, SUGGESTED],
    namedResults: () =>
      toolCalls.map((c, i) => ({ name: c.name, text: [READ, SIMILAR, SUGGESTED][i] as string })),
    fallback: 'code-authored',
  });
  return { text: message?.text ?? null, asked };
}

describe('a BA turn that proposed the revision through ba_suggest', () => {
  for (const draft of [
    'I drafted revision r2 of REQ-32 as a suggestion: BC-6 and BC-7 reworded, a new criterion added, every other criterion kept.',
    'Proposed r2 of REQ-32 for your review.',
    'I have created a revision suggestion for REQ-32; it waits on your accept.',
  ]) {
    it(`says so as written: "${draft.slice(0, 40)}…"`, async () => {
      const out = await screen(draft, []);
      expect(out.asked).toEqual([]);
      expect(out.text).toBe(draft);
    });
  }

  it('is held where the suggestion was refused: a refused write grounds nothing', async () => {
    const draft = 'I drafted revision r2 of REQ-32 as a suggestion.';
    const out = await screen(draft, [draft], { suggest: { isError: true } });
    expect(out.asked).toHaveLength(1);
    expect(out.asked[0]).toContain('ba_suggest');
    expect(out.text).toContain('it said it had done something');
  });
});

describe('a check that cannot run', () => {
  it('is named, with why, and never read as "nothing failed"', async () => {
    const draft = 'Suggested r2 of REQ-32. The project has 12 issues done and 40 remaining.';
    const out = await screen(draft, [draft], { progress: null });
    expect(out.text).toContain('could not run');
    expect(out.text).toContain("the project's progress snapshot could not be computed this turn");
    expect(out.text).not.toContain('Nothing failed');
    expect(out.text).not.toMatch(/could not check the project's figures/);
  });

  it('that held nothing leaves the answer alone', async () => {
    const draft = 'Suggested r2 of REQ-32. Every other criterion is kept.';
    const out = await screen(draft, [], { progress: null });
    expect(out.text).toBe(draft);
  });
});
