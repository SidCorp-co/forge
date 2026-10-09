// A rewrite the reply screen asks for is held to the answer it rewrites (dev QA 2026-10-07, conversation
// e71004df: a TRUE "the oldest needs_info issue is ISS-261, created 2026-10-06 15:24:11 UTC" was
// withdrawn for its hash-route link, and the rewrite, which read only a 300-character digest of
// the list, delivered a FALSE "the oldest is ISS-299"). The issue rows and this turn's tool results
// are the ones that turn held; the database read is the one thing replaced.

import { describe, expect, it, vi } from 'vitest';
import { facts } from '../messaging/facts.js';

vi.mock('../messaging/gather.js', () => ({
  gatherFacts: async (input: {
    toolCalls?: readonly { name: string; arguments: string }[];
    offeredTools?: readonly string[];
  }) =>
    facts({
      toolCalls: input.toolCalls ?? [],
      offeredTools: input.offeredTools ?? [],
      prefix: 'ISS',
      prefixes: ['ISS'],
      knownIssueSeqs: new Set([261, 277, 290, 299, 300]),
      issueRows: new Map(
        [261, 277, 290, 299, 300].map((seq) => [seq, { seq, merged: true, status: 'needs_info' }]),
      ),
    }),
}));

const { screenedTurnReply } = await import('./screened-reply.js');

const LIST = `{"exitCode":0,"stdout":"ISS-299  high     needs_info   No dev run has yet gone from open to awaiting_release with the plugin CLI and hooks absent\\nISS-261  medium   needs_info   A write that proposes a new revision of an approved design takes no issue\\nISS-277  medium   needs_info   Ask Agent opens a new conversation on every click\\nISS-290  medium   needs_info   A requirement asks the owner to promote its draft issues\\n\\n4 issue(s) over 1 page(s), which is every row matching this ask.\\n","stderr":""}`;
const ISS_261 = `{"exitCode":0,"stdout":"{\\n  \\"documentId\\": \\"e3fa3c20-dce0-4a89-9eb0-b616bb82e993\\",\\n  \\"issueId\\": \\"ISS-261\\",\\n  \\"status\\": \\"needs_info\\",\\n  \\"createdAt\\": \\"2026-10-06T15:24:11.469Z\\"\\n}"}`;
const ISS_299 = `{"exitCode":0,"stdout":"{\\n  \\"documentId\\": \\"c9329501-e0c2-40d9-bc15-00a45b71f57e\\",\\n  \\"issueId\\": \\"ISS-299\\",\\n  \\"status\\": \\"needs_info\\",\\n  \\"createdAt\\": \\"2026-10-06T23:16:45.545Z\\"\\n}"}`;
const RESULTS = [LIST, ISS_299, ISS_261];
const CALLS = [
  { name: 'forge', arguments: '{"argv":["issue","--status","needs_info","--limit","200"]}' },
  { name: 'forge', arguments: '{"argv":["issue","ISS-299"]}' },
  { name: 'forge', arguments: '{"argv":["issue","ISS-261"]}' },
];

// i18n-allow: the production reply replayed as the test case
const TRUE_DRAFT =
  'Hiện có **4 issue** ở trạng thái `needs_info`.\n\nIssue cũ nhất là **[ISS-261](#/projects/forge/issues/e3fa3c20-dce0-4a89-9eb0-b616bb82e993)**, được tạo lúc **2026-10-06 15:24:11 UTC**. Issue này liên quan đến việc revision mới của workflow design có thể kế thừa issue đã đóng hoặc không có issue.'; // i18n-allow: the production reply replayed as the test case
// i18n-allow: the production rewrite replayed as the test case
const FALSE_REWRITE =
  'Hiện có **4 issue** ở trạng thái `needs_info`.\n\nIssue cũ nhất là [ISS-299 — No dev run has yet gone from open to awaiting_release…](/projects/forge/issues/c9329501-e0c2-40d9-bc15-00a45b71f57e), mức ưu tiên **high**.'; // i18n-allow: the production rewrite replayed as the test case

const WRONG_DATE = 'Issue cũ nhất là ISS-261, được tạo lúc 2026-10-01.'; // i18n-allow: the case under test

const attempt = (
  reply: string,
  terminal: 'done' | 'error' = 'done',
  toolCalls: readonly { name: string; arguments: string }[] = CALLS,
) => ({
  conversationId: 'c-1',
  reply,
  terminal,
  error: terminal === 'error' ? 'stream disconnected' : null,
  iterations: 1,
  toolCalls: [...toolCalls],
  progress: null,
});

async function screen(
  first: string,
  retries: ReturnType<typeof attempt>[],
  more: { offeredTools?: readonly string[]; results?: readonly string[] } = {},
) {
  const asked: string[] = [];
  const message = await screenedTurnReply({
    door: 'web-chat-reply',
    projectId: 'p-1',
    handleName: 'forge',
    language: 'vi',
    askedIn: 'vi',
    first: attempt(first),
    retry: async (instruction) => {
      asked.push(instruction);
      const next = retries.shift();
      if (!next) throw new Error('the test scripted no further attempt');
      return next;
    },
    setPhase: () => undefined,
    toolResults: () => [...RESULTS, ...(more.results ?? [])],
    ...(more.offeredTools ? { offeredTools: more.offeredTools } : {}),
    fallback: 'code-authored',
    brokenReport: () => 'BROKEN-REPORT',
  });
  return { text: message?.text ?? null, proof: message?.proof ?? null, asked };
}

describe('a true answer is never rewritten into a false one', () => {
  it('the production case: the hash link is pointed at the web path and the true answer goes out, unrewritten', async () => {
    const out = await screen(TRUE_DRAFT, [attempt(FALSE_REWRITE)]);
    expect(out.asked, 'a link the web can serve needs no model rewrite').toHaveLength(0);
    expect(out.text).toContain('Issue cũ nhất là **[ISS-261](/projects/forge/issues/e3fa3c20'); // i18n-allow: the production reply replayed as the test case
    expect(out.text).not.toContain('ISS-299');
    expect(out.proof).not.toBeNull();
  });

  it('a rewrite that names an issue the answer did not, where no issue claim was refused, is refused; the one clause it held is cut, never sent marked (REQ-41 BC-3)', async () => {
    const wrongDate = WRONG_DATE; // i18n-allow: the case under test
    const out = await screen(wrongDate, [
      attempt('Issue cũ nhất là ISS-299, được tạo lúc 2026-10-06.'), // i18n-allow: the case under test
    ]);
    expect(out.asked).toHaveLength(1);
    expect(out.text).not.toContain('ISS-299');
    expect(out.text).not.toContain('2026-10-01');
    expect(out.text).toContain(
      'forge wrote an answer, but the reply check held it: it stated a date',
    );
    expect(
      out.proof,
      'with no clause left and no block, the held line is code-authored',
    ).toBeNull();
  });

  it('a rewrite that corrects only the refused date from what the turn read goes out', async () => {
    const out = await screen(WRONG_DATE, [
      // i18n-allow: the case under test
      attempt('Issue cũ nhất là ISS-261, được tạo lúc 2026-10-06.'), // i18n-allow: the case under test
    ]);
    expect(out.text).toBe('Issue cũ nhất là ISS-261, được tạo lúc 2026-10-06.'); // i18n-allow: the case under test
  });

  it('a rewrite stating a date nothing read carries is refused, and neither date goes out', async () => {
    const out = await screen(WRONG_DATE, [
      // i18n-allow: the case under test
      attempt('Issue cũ nhất là ISS-261, được tạo lúc 2026-09-20.'), // i18n-allow: the case under test
    ]);
    expect(out.text).not.toContain('2026-10-01');
    expect(out.text).not.toContain('2026-09-20');
    expect(out.text).toContain('the reply check held it');
  });

  it('a rewrite the provider broke off, over an answer nothing can mark, is reported as the failure it is', async () => {
    const out = await screen('Mình sẽ kiểm tra ISS-261 rồi báo lại nhé.', [attempt('', 'error')]); // i18n-allow: the case under test
    expect(out.text).toBe('BROKEN-REPORT');
  });
});

describe('a rewrite answers to both the status-claims rule and the rewrite rule', () => {
  const OFFERED = ['forge', 'forge_project_status'];
  const STATUS_READ = { name: 'forge_project_status', arguments: '{}' };
  const STATUS = '{"shipped":[{"issue":"ISS-290","release":"0.4.0-dev.123"}]}';
  // a shipped claim with no status read this turn: refused by status-claims-grounded
  const UNREAD = 'ISS-261 đã phát hành.'; // i18n-allow: the case under test
  const STILL_UNREAD = 'ISS-261 đã phát hành rồi.'; // i18n-allow: the case under test

  it('a rewrite that reads the status and names what that read returned passes both', async () => {
    const out = await screen(
      UNREAD,
      [
        attempt('ISS-290 đã phát hành trong 0.4.0-dev.123.', 'done', [...CALLS, STATUS_READ]), // i18n-allow: the case under test
      ],
      { offeredTools: OFFERED, results: [STATUS] },
    );
    expect(out.asked).toHaveLength(1);
    expect(out.asked[0]).toContain('no read this turn grounds it');
    expect(out.text).toBe('ISS-290 đã phát hành trong 0.4.0-dev.123.'); // i18n-allow: the case under test
  });

  it('a rewrite that reads the status but names an issue no result carries fails the rewrite rule', async () => {
    const out = await screen(
      UNREAD,
      [attempt('ISS-300 đã phát hành.', 'done', [...CALLS, STATUS_READ])], // i18n-allow: the case under test
      { offeredTools: OFFERED, results: ['{"shipped":[]}'] },
    );
    expect(out.text).not.toContain('ISS-300');
    expect(out.text, 'the original is still unread, so marking it cannot pass either').toContain(
      'the reply check held it: it said where the work stands without a read that shows it',
    );
  });

  it('a rewrite that keeps the claim and still reads nothing fails the status-claims rule', async () => {
    const out = await screen(UNREAD, [attempt(STILL_UNREAD)], {
      // i18n-allow: the case under test
      offeredTools: OFFERED,
    });
    expect(out.text).not.toContain('đã phát hành rồi'); // i18n-allow: the case under test
  });
});
