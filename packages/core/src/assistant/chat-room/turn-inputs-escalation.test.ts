// ISS-857 (owner ruling agent-is-the-voice): a fast turn that escalates says it in its own words or
// says nothing. Core composes no "looking into this in depth", "still looking into the previous
// question" or "no runner is free" line on the escalation path; the model's own reply goes out only
// once it passes the room's reply check.

import { ESCALATE_TOOL_NAME } from '@forge/contracts/assistant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Started =
  | { started: true; sessionId: string }
  | { started: false; reason: string; message?: string };

let started: Started = { started: true, sessionId: 's-1' };
let screenOk = true;

vi.mock('./escalation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./escalation.js')>()),
  startEscalation: async () => started,
}));
vi.mock('../../messaging/reply-screen.js', () => ({
  screenReplyAtDoor: async () =>
    screenOk ? { ok: true } : { ok: false, refusals: [{ rule: 'r', why: 'w' }] },
}));
vi.mock('../../conversations/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../conversations/index.js')>()),
  screened: (text: string, door: string, verdict: { ok: boolean }) =>
    verdict.ok ? { text, proof: { text, door } } : null,
}));

const { rocketChatTurn } = await import('./turn-inputs.js');

const turn = () =>
  rocketChatTurn({
    bot: { botName: 'Bao', serverUrl: 'https://chat.example', authToken: 't', botUserId: 'b' },
    route: { projectId: 'p-1', projectSlug: 'p', projectName: 'P' } as never,
    subject: {
      rid: 'r-1',
      tmid: undefined,
      text: 'how does the release pipeline promote a build?',
      username: 'an',
      messageIds: ['m-1'],
      images: [],
    },
    connectionId: 'conn-1',
    shape: 'group',
    webBaseUrl: undefined,
    cut: { reason: 'quiet', coveredSeq: [1, 1], snapshotAt: new Date() },
    window: {
      venue: { adapter: 'rocketchat', externalId: 'ns r-1', shape: 'group', projectId: 'p-1' },
      conversationId: 'c-1',
      windowId: 'w-1',
      deliveryKey: 'window:w-1',
    },
  });

const escalated = (reply: string) =>
  ({
    reply,
    terminal: 'done',
    error: null,
    iterations: 1,
    conversationId: null,
    progress: null,
    toolCalls: [{ name: ESCALATE_TOOL_NAME, arguments: JSON.stringify({ question: 'q' }) }],
  }) as never;

const divert = async (reply: string) =>
  turn().divertAfterTurn?.(escalated(reply), {
    setPhase: () => undefined,
    authority: { origin: 'message', userId: 'u-1', viaTokenId: null },
  } as never);

const CANNED = [
  /looking into this question in depth/,
  /still looking into this room/,
  /no runner is free/,
  /đang tìm hiểu/, // i18n-allow: the removed Vietnamese ack under test
  /Xin lỗi, hiện không có runner/, // i18n-allow: the removed Vietnamese no-device line under test
];

beforeEach(() => {
  started = { started: true, sessionId: 's-1' };
  screenOk = true;
});

describe('a fast turn that escalates', () => {
  it('posts its own words when they pass the check, never a core line', async () => {
    const own = 'A teammate is digging into the pipeline code; the answer lands in this thread.';
    const reply = await divert(own);
    expect(reply).toMatchObject({ send: true, message: { text: own } });
    expect(reply && 'message' in reply ? reply.message.proof : null).not.toBeNull();
  });

  it('posts nothing when the model wrote nothing', async () => {
    const reply = await divert('');
    expect(reply).toMatchObject({ send: false });
  });

  it('posts nothing when its words fail the check', async () => {
    screenOk = false;
    expect(await divert('I will look into it.')).toMatchObject({ send: false });
  });

  it.each([
    ['deduped', { started: false, reason: 'deduped' }],
    ['no-device', { started: false, reason: 'no-device' }],
  ] as const)('composes no line of its own when the escalation was %s', async (_n, s) => {
    started = s;
    const reply = await divert('');
    const text = reply && 'message' in reply ? reply.message.text : '';
    for (const canned of CANNED) expect(text).not.toMatch(canned);
    expect(reply).toMatchObject({ send: false });
  });

  it('a started escalation with no words of its own posts no ack', async () => {
    const reply = await divert('');
    const text = reply && 'message' in reply ? reply.message.text : '';
    for (const canned of CANNED) expect(text).not.toMatch(canned);
  });
});
