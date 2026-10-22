// REQ-41 BC-3, probe of 2026-10-09: the assistant's answer to "what is waiting on me" was held
// whole by the reply check, so the person saw only the held line. A reply the check holds now shows
// the part it could check: the clause holding the claim nothing read backs is cut, the rest goes out
// with one notice naming what was left out, and the blocks the turn's reads drew go with it. Only
// where no clause and no block is left is it withheld. The screen runs whole; the one thing
// replaced is the database read.

import { beforeAll, describe, expect, it } from 'vitest';
import type { IssueStatus } from '../db/schema.js';
import type { StagedBlock } from '../lib/staged-block.js';
import { provideMessageReads } from '../messaging/reads.js';
import { TurnBlockStage } from './turn-stage.js';

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
  computedAt: new Date('2026-10-09T12:14:00Z'),
};
const OFFERED = ['forge_report', 'forge_template', 'forge_show', 'forge_project_status'];

const attempt = (reply: string) => ({
  conversationId: 'c-1',
  reply,
  terminal: 'done' as const,
  error: null,
  iterations: 1,
  toolCalls: [STATUS_CALL],
  progress: PROGRESS,
});

const block = (): StagedBlock => ({
  text: 'Waiting on you',
  block: {
    type: 'visual',
    visual: { kind: 'callout', title: 'Waiting on you', body: 'From the project status.' },
  },
  kind: 'callout',
  runId: null,
  projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
  askerUserId: 'u-1',
});

async function screen(first: string, opts: { blocks?: number } = {}) {
  const stage = new TurnBlockStage();
  for (let i = 0; i < (opts.blocks ?? 0); i += 1) await stage.stage.hold(block());
  const message = await screenedTurnReply({
    door: 'web-chat-reply',
    projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
    handleName: 'forge',
    language: 'en',
    askedIn: 'en',
    question: 'what is waiting on me?',
    first: attempt(first),
    // every rewrite says the same, so no rewrite passes and the screen is exhausted
    retry: async () => attempt(first),
    setPhase: () => undefined,
    offeredTools: OFFERED,
    toolResults: () => [STATUS],
    namedResults: () => [{ name: 'forge_project_status', text: STATUS }],
    fallback: 'code-authored',
    stage,
  });
  return { message, kept: stage.kept() };
}

const CHECKED = 'The project status shows 196 issues: 100 shipped and 41 in progress.';
const UNBACKED = 'There are 4,812 decisions waiting on you.';

describe('a reply the check holds shows the part it could check (REQ-41 BC-3)', () => {
  it('cuts the clause nothing read backs and sends the checked clause with the notice', async () => {
    const { message } = await screen(`${CHECKED} ${UNBACKED}`);
    expect(message?.text).toBe(
      `${CHECKED}\n\nThe reply check left out a figure that nothing this answer read backs. What is shown above was checked.`,
    );
    expect(message?.text).not.toContain('4,812');
    expect(message?.held).toEqual({
      verdict: 'partial',
      shown: CHECKED,
      blocks: 0,
      held: [{ claim: 'figure', count: 1 }],
    });
    expect(message?.proof, 'the shown part and its notice passed the same screen').not.toBeNull();
  });

  it('shows the blocks its reads drew when no clause is left, never nothing', async () => {
    const { message, kept } = await screen(UNBACKED, { blocks: 1 });
    expect(message?.text).toBe(
      'The reply check left out a figure that nothing this answer read backs. What is shown above was checked.',
    );
    expect(message?.held).toMatchObject({ verdict: 'partial', shown: '', blocks: 1 });
    expect(kept, 'the block the first answer drew is released with the notice').toHaveLength(1);
  });

  it('is withheld as the held line only where no clause and no block is left', async () => {
    const { message, kept } = await screen(UNBACKED);
    expect(message?.held).toBeUndefined();
    expect(message?.text).toContain(
      'forge wrote an answer, but the reply check held it: it stated a figure that nothing it read backs.',
    );
    expect(kept).toHaveLength(0);
  });
});

// Dev, 2026-10-21 (conversation a760cd5f, "when will it be handled?"): the owner got "the reply check
// held it" with no reason and no answer, because the refused sentence broke a rule the cut did not
// name a claim for, so nothing of the checked answer was shown (REQ-41 BC-3).
describe('a sentence held by a rule naming no read is cut, and the rest still answers (REQ-41 BC-3)', () => {
  it('cuts a promised follow-up no later turn makes, and sends the checked sentence', async () => {
    const { message } = await screen(`${CHECKED} I'll check again and get back to you.`);
    expect(message?.text).toBe(
      `${CHECKED}\n\nThe reply check left out a promised follow-up that nothing this answer read backs. What is shown above was checked.`,
    );
    expect(message?.held).toMatchObject({
      verdict: 'partial',
      held: [{ claim: 'promise', count: 1 }],
    });
  });

  it('cuts a figure whose read it does not name, keeping the sentence that names its read', async () => {
    const { checkedPart } = await import('./screened-reply.js');
    const refused = {
      rule: 'figures-name-source',
      why: 'the reply states the figure 50 and names no read it came from',
      quote: '50',
      shape: 's',
      example: 'e',
    };
    const part = await checkedPart(
      `${CHECKED} Separately, 50 have not started yet.`,
      [refused],
      async () =>
        ({
          ok: true,
        }) as never,
    );
    expect(part).toEqual({ shown: CHECKED, held: [{ claim: 'figure', count: 1 }] });
  });
});

describe('a false opening no rewrite drops is taken off, and the answer goes out whole (REQ-41 BC-30)', () => {
  it('sends the checked answer without "Correct", and with no notice of anything left out', async () => {
    const { message } = await screen(`Correct. ${CHECKED}`);
    expect(message?.text).toBe(CHECKED);
    expect(message?.held).toBeUndefined();
    expect(message?.proof, 'what goes out passed the same screen').not.toBeNull();
  });
});
