// A failed turn's one terminal status is the report it composed: why it stopped, in the asker's
// language, and what it did and found; the bare "nothing was sent" line only where no report exists
// (dev QA 2026-10-07: a turn that streamed for ~45 s posted "forge could not reach its model, so
// nothing was sent"). The transport and the window's own rows are the things replaced.

import { describe, expect, it, vi } from 'vitest';

const recorded: { text: string; decision?: string }[] = [];

vi.mock('./window-claim.js', () => ({ reserveDelivery: async () => true }));
vi.mock('./transcript.js', () => ({
  recordDeliveredReply: async (row: { text: string; decision?: string }) => {
    recorded.push(row);
  },
}));

const { failedTurnReport } = await import('./fallback-replies.js');
const { codeAuthored, registerConversationTransport } = await import('./ports.js');
const { newRequestTrack, withTerminalStatus } = await import('./request-status.js');

const delivered: string[] = [];
registerConversationTransport({
  adapter: 'web',
  async deliver(_venue: unknown, message: { text: string }) {
    delivered.push(message.text);
    return { messageId: `m-${delivered.length}`, deliveredText: null } as never;
  },
  async fetchHistory() {
    return [];
  },
} as never);

function track() {
  const t = newRequestTrack();
  t.anchor = {
    messageId: null,
    receivedAt: new Date(),
    authorLabel: 'asker',
    text: 'Soạn giúp mình một spec', // i18n-allow: the production ask replayed as the test case
  };
  t.venue = { adapter: 'web', externalId: 'room-1', shape: 'direct', projectId: 'p-1' };
  t.handleName = 'forge';
  t.language = 'vi';
  return t;
}

const window = { id: 'w-1', conversationId: 'c-1', projectId: 'p-1' };
const claim = { claimedAt: new Date(), claimedBy: 'test' };
const unreachable = {
  decision: 'unreachable' as const,
  detail: { code: 'ASSISTANT_TURN_FAILED', reason: 'r', cause: 'provider' },
};

describe("a failed turn's status is its report", () => {
  it('posts the report: why in Vietnamese with its code, then what it read and drafted', async () => {
    delivered.length = 0;
    const report = codeAuthored(
      failedTurnReport({
        name: 'forge',
        language: 'vi',
        code: 'ASSISTANT_TURN_FAILED',
        cause: 'provider',
        findings: 'Đã đọc: đọc tri thức dự án.', // i18n-allow: the Vietnamese report under test
      }),
    );
    const routed = await withTerminalStatus(unreachable, {
      window,
      deliveryKey: 'k-1',
      claim,
      track: track(),
      report,
    });
    expect(delivered).toEqual([report.text]);
    expect(delivered[0]).toContain(
      'forge chưa trả lời xong: mô hình ngừng trả lời giữa chừng. (ASSISTANT_TURN_FAILED)', // i18n-allow: the Vietnamese report under test
    );
    expect(delivered[0]).toContain('Đã đọc: đọc tri thức dự án.'); // i18n-allow: the Vietnamese report under test
    expect(delivered[0]).not.toContain('chưa gửi gì'); // i18n-allow: the Vietnamese line that must not stand
    expect(routed.detail).toMatchObject({ cause: 'provider', status: { delivered: true } });
  });

  it('without a report, the coded line stands, as before', async () => {
    delivered.length = 0;
    await withTerminalStatus(unreachable, { window, deliveryKey: 'k-2', claim, track: track() });
    expect(delivered[0]).toContain('(ASSISTANT_TURN_FAILED)');
  });
});

describe('the report names what failed in the words of each cause', () => {
  it.each([
    ['provider', 'its model stopped answering partway'],
    ['crash', 'it hit an internal error'],
    ['timeout', 'could not finish this in the time a turn has'],
  ] as const)('%s', (cause, words) => {
    const text = failedTurnReport({
      name: 'forge',
      language: 'en',
      code: cause === 'timeout' ? 'ASSISTANT_TURN_TIMED_OUT' : 'ASSISTANT_TURN_FAILED',
      cause,
      findings: null,
    });
    expect(text).toContain(words);
    expect(text).toContain('It had not done or read anything yet.');
  });
});
