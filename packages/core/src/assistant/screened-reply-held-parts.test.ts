// REQ-41 BC-3, QA of 0.4.0-dev.219 (ISS-495): "What is REQ-31's state, and is ISS-9998 done?" and
// "open ISS-493 and highlight its plan" were held WHOLE, so the person saw only the held line and
// nothing of REQ-31. Two causes. A refusal that quoted nothing (the issue-creation claim) could not
// be cut, and "opened ISS-493" is what the page's own ui_open reports, not a creation claim; and a
// clause joining two statements was cut whole, so one unbacked key took the backed statement with it.
// The screen runs whole; the one thing replaced is the database read.

import { beforeAll, describe, expect, it } from 'vitest';
import { provideMessageReads } from '../messaging/reads.js';

const { screenedTurnReply } = await import('./screened-reply.js');

beforeAll(() => {
  provideMessageReads({
    activeIssuePrefix: async () => 'ISS',
    heldIssuePrefixes: async () => [],
    citedIssues: async (_project, cited) =>
      cited.seqs
        .filter((n) => n === 493 || n === 495)
        .map((n) => ({ id: `id-${n}`, issSeq: n, status: 'needs_info', mergedAt: null })),
    workflowDesign: async () => ({ kind: 'missing', flows: [] }),
    contractHolding: async () => ({ projectSlug: 'p', versions: [], named: false }),
    readsTechnical: async () => true,
    reportRunFrames: async () => [],
    agreedRecords: async () => [],
  });
});

const REQ = JSON.stringify({
  key: 'REQ-31',
  title: 'The Ask Agent panel opens at its largest width',
  state: 'in_delivery',
  waitingOn: { kind: 'you', act: 'make a decision on ISS-493' },
});
const OPEN = { name: 'ui_open', arguments: '{"key":"ISS-493","kind":"issue"}' };
const READ = { name: 'forge_requirement', arguments: '{"requirement":"REQ-31"}' };

async function ask(question: string, reply: string, calls: { name: string; arguments: string }[]) {
  const attempt = {
    conversationId: 'c-1',
    reply,
    terminal: 'done' as const,
    error: null,
    iterations: 1,
    toolCalls: calls,
    progress: null,
  };
  return screenedTurnReply({
    door: 'web-chat-reply',
    projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
    handleName: 'forge',
    language: 'en',
    askedIn: 'en',
    question,
    first: attempt,
    retry: async () => attempt,
    setPhase: () => undefined,
    offeredTools: ['forge_requirement', 'ui_open', 'ui_highlight'],
    toolResults: () => [REQ],
    namedResults: () => [{ name: 'forge_requirement', text: REQ }],
    fallback: 'code-authored',
  });
}

const QUESTION = "What is REQ-31's state, and is ISS-9998 done?";
const NOTICE = 'The reply check left out an issue key that nothing this answer read backs.';

describe('a held reply shows the part it could check (REQ-41 BC-3, QA of dev.219)', () => {
  it('keeps the REQ-31 statement when one clause joins it to the unbacked key', async () => {
    const m = await ask(
      QUESTION,
      'REQ-31 is in delivery (waiting on you to decide ISS-493), and ISS-9998 does not exist on the tracker.',
      [READ],
    );
    expect(m?.held).toMatchObject({
      verdict: 'partial',
      shown: 'REQ-31 is in delivery (waiting on you to decide ISS-493).',
    });
    expect(m?.text).toContain(NOTICE);
    expect(m?.text).not.toContain('ISS-9998');
  });

  it('keeps the statement before a leading unbacked part, raised as a sentence', async () => {
    const m = await ask(
      QUESTION,
      'ISS-9998 does not exist on the tracker, and REQ-31 is in delivery for now.',
      [READ],
    );
    expect(m?.held).toMatchObject({ verdict: 'partial', shown: 'REQ-31 is in delivery for now.' });
  });

  it('cuts a labelled line through its claim, never leaving the claim behind its label', async () => {
    const m = await ask(QUESTION, '- REQ-31: in delivery\n- ISS-9998: not found on the tracker', [
      READ,
    ]);
    expect(m?.held).toMatchObject({ verdict: 'partial', shown: '- REQ-31: in delivery' });
    expect(m?.text).not.toContain('not found');
  });

  it('does not take "opened ISS-493" for a creation claim where ui_open opened it', async () => {
    const reply =
      'I opened ISS-493 for you. I could not highlight its plan, the tool refused the call.';
    const m = await ask('open ISS-493 and highlight its plan', reply, [OPEN]);
    expect(m?.text).toBe(reply);
    expect(m?.held).toBeUndefined();
  });

  it('still holds "opened ISS-493" where nothing opened it, and shows the rest', async () => {
    const m = await ask(
      'open ISS-493 and highlight its plan',
      'REQ-31 is in delivery. I opened ISS-493 and made a note.',
      [READ],
    );
    expect(m?.held).toMatchObject({ verdict: 'partial', shown: 'REQ-31 is in delivery.' });
    expect(m?.text).toContain('The reply check left out a claim to have saved or shared something');
  });

  it('cuts a creation claim that quotes nothing, so the checked part still shows', async () => {
    const m = await ask(QUESTION, 'REQ-31 is in delivery. I created a new issue for it.', [READ]);
    expect(m?.held).toMatchObject({ verdict: 'partial', shown: 'REQ-31 is in delivery.' });
  });
});
