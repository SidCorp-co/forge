// The Agent reply of conversation 218168c7 (dev, 2026-10-08), replayed at its own door: it filed
// ISS-395 as a draft, asked three questions, and said it would update the issue once they were
// answered. The screen held it as an empty promise, and the asker was told the session had ended
// without an answer. The database read is the one thing replaced: the issue row is what dev held.

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { facts } from './facts.js';

const ROWS = new Map([[395, { seq: 395, merged: false, status: 'draft' }]]);

vi.mock('./gather.js', () => ({
  gatherFacts: async (input: { toolCalls?: readonly { name: string; arguments: string }[] }) =>
    facts({
      prefix: 'ISS',
      prefixes: ['ISS'],
      knownIssueIds: new Set(['f4a82b24-bb6b-48b4-913f-8ba57f5af4e2']),
      knownIssueSeqs: new Set(ROWS.keys()),
      issueRows: ROWS,
      toolCalls: input.toolCalls ?? [],
      progress: { total: 394, shipped: 345, inFlight: 0, remaining: 44, closedUnshipped: 5 },
    }),
}));

const { screenReplyAtDoor } = await import('./reply-screen.js');

const HELD = readFileSync(
  new URL('../../tests/fixtures/messaging/held-agent-reply-iss-395.txt', import.meta.url),
  'utf8',
).trim();

const FILED = {
  name: 'Bash',
  arguments: JSON.stringify({
    command: 'forge-runner api projects/d1bb4907/issues -X POST -d "$(cat /tmp/iss.json)"',
  }),
};

const screen = (text: string, door: 'web-agent-completion' | 'agent-chat-completion') =>
  screenReplyAtDoor(door, {
    projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
    segments: [text],
    toolCalls: [FILED],
    progress: null,
  });

const rules = (v: Awaited<ReturnType<typeof screen>>) =>
  v.ok ? [] : v.refusals.map((r) => r.rule);

describe('an Agent reply that asks the reader something may say what it will do with the answer', () => {
  it('passes the reply that was held on 2026-10-08, word for word', async () => {
    expect(rules(await screen(HELD, 'web-agent-completion'))).toEqual([]);
  });

  it('passes the same promise in English, conditioned on the reader confirming', async () => {
    const reply =
      "I filed ISS-395 as a draft. Once you confirm the three points, I'll check the widths again and update the issue.";
    expect(rules(await screen(reply, 'web-agent-completion'))).toEqual([]);
  });

  it('still refuses a promise of later work that waits on nobody but the writer', async () => {
    const vi1 = 'Mình sẽ kiểm tra lại độ rộng panel và báo lại bạn sau.'; // i18n-allow: the Vietnamese empty promise the rule exists for
    const vi2 = 'Bạn chờ chút, mình sẽ kiểm tra rồi cập nhật issue.'; // i18n-allow: a reader told to wait is not a reader asked to answer
    const vi3 = 'Sẽ phản hồi bạn sớm.'; // i18n-allow: a promise to reply back binds the writer whoever is its subject
    const en = "I'll look into the panel width and get back to you.";
    for (const reply of [vi1, vi2, vi3, en]) {
      expect(rules(await screen(reply, 'web-agent-completion')), reply).toContain(
        'no-empty-promise',
      );
    }
  });

  it('reads "will check" and "will see" as a promise only with the writer as their subject', async () => {
    const spec = '- Phần trang co giãn ở cả hai cỡ. Sẽ kiểm tra trên màn 1280px và 1366px.'; // i18n-allow: what the filed issue's acceptance will check, quoted from the held reply
    const reader = 'Bạn sẽ xem được panel ở cỡ lớn ngay lần mở đầu.'; // i18n-allow: what the reader will see is not the writer's promise
    for (const reply of [spec, reader]) {
      expect(rules(await screen(reply, 'web-agent-completion')), reply).toEqual([]);
    }
  });

  it('does not let a question in one sentence excuse a promise made in another', async () => {
    const reply = 'Mình sẽ kiểm tra lại. Bạn xác nhận giúp ba điểm trên nhé.'; // i18n-allow: a question that does not condition the promise beside it
    expect(rules(await screen(reply, 'web-agent-completion'))).toContain('no-empty-promise');
  });

  it('still refuses an issue the reply names that this project does not hold', async () => {
    const reply = HELD.replaceAll('ISS-395', 'ISS-396');
    expect(rules(await screen(reply, 'web-agent-completion'))).toContain('issue-keys-exist');
  });
});
