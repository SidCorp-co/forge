/**
 * ISS-671 (AC#1) — the static half of the outbound chokepoint's enforcement:
 * no file under packages/core/src other than the rocketchat outbound/rest-client/
 * ddp-client trio may call the raw RC send primitives. A fifth reply path that
 * forgets the door now fails CI instead of shipping unguarded. Scoped to the
 * whole src tree (not just this directory) per AC#1 — a bypass anywhere in the
 * package is the same failure.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ALLOWED = new Set([
  'integrations/rocketchat/outbound.ts',
  'integrations/rocketchat/rest-client.ts',
  'integrations/rocketchat/ddp-client.ts',
]);
const CALL_RE = /postRoomMessage\(|\.sendMessage\(/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function listSourceFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full, rel));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
  return out;
}

describe('outbound chokepoint — no bypass (ISS-671 AC#1)', () => {
  it('no file under src other than the rocketchat outbound/rest-client/ddp-client trio calls postRoomMessage or .sendMessage', () => {
    const violations: string[] = [];
    for (const rel of listSourceFiles(SRC_ROOT)) {
      if (ALLOWED.has(rel)) continue;
      const body = stripComments(readFileSync(`${SRC_ROOT}${rel}`, 'utf8'));
      if (CALL_RE.test(body)) violations.push(rel);
    }
    expect(
      violations,
      `A reply path is calling the RC send primitive directly instead of going through outbound.ts (sendStakeholderReply/sendFixedReply). Offending files:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('the scan actually detects a planted bypass (meta-test)', () => {
    const planted = 'await client.sendMessage(rid, text, tmid);';
    expect(CALL_RE.test(stripComments(planted))).toBe(true);
    const plantedRest = 'await postRoomMessage(auth, rid, text);';
    expect(CALL_RE.test(stripComments(plantedRest))).toBe(true);
    const clean = 'await sendFixedReply(transport, text);';
    expect(CALL_RE.test(stripComments(clean))).toBe(false);
  });
});

const screenStakeholderReply = vi.fn();
vi.mock('./reply-screen.js', () => ({
  screenStakeholderReply: (...args: unknown[]) => screenStakeholderReply(...args),
}));

const postRoomMessage = vi.fn();
vi.mock('./rest-client.js', () => ({
  postRoomMessage: (...args: unknown[]) => postRoomMessage(...args),
}));

const { FIXED_REPLY_CONSTANT, sendStakeholderReply, sendFixedReply } = await import(
  './outbound.js'
);

function ddpTransport(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ddp' as const,
    client: { sendMessage: vi.fn() },
    rid: 'room-1',
    tmid: undefined,
    authToken: 'bot-token',
    ...overrides,
  };
}

function restTransport() {
  return {
    kind: 'rest' as const,
    auth: { serverUrl: 'https://chat.example.co', authToken: 'tok', userId: 'bot-1' },
    rid: 'room-1',
    tmid: undefined,
  };
}

describe('sendStakeholderReply', () => {
  beforeEach(() => {
    screenStakeholderReply.mockReset();
    postRoomMessage.mockReset();
  });

  it('screens then delivers over DDP when the guard passes', async () => {
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
    const transport = ddpTransport();
    const outcome = await sendStakeholderReply({
      projectId: 'proj-1',
      text: 'Here is the answer.',
      toolCalls: [],
      progress: null,
      transport: transport as never,
    });
    expect(outcome).toEqual({ sent: true });
    expect(transport.client.sendMessage).toHaveBeenCalledWith(
      'room-1',
      'Here is the answer.',
      undefined,
    );
  });

  it('delivers nothing when the guard rejects', async () => {
    screenStakeholderReply.mockResolvedValue({ ok: false, problems: ['leaks a code fence'] });
    const transport = ddpTransport();
    const outcome = await sendStakeholderReply({
      projectId: 'proj-1',
      text: '```leaky```',
      toolCalls: [],
      progress: null,
      transport: transport as never,
    });
    expect(outcome).toEqual({ sent: false, problems: ['leaks a code fence'] });
    expect(transport.client.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects an empty reply without calling the guard or delivering', async () => {
    const transport = ddpTransport();
    const outcome = await sendStakeholderReply({
      projectId: 'proj-1',
      text: '   ',
      toolCalls: [],
      progress: null,
      transport: transport as never,
    });
    expect(outcome).toEqual({ sent: false, problems: ['empty reply'] });
    expect(screenStakeholderReply).not.toHaveBeenCalled();
    expect(transport.client.sendMessage).not.toHaveBeenCalled();
  });

  it('threads the progress snapshot into the guard', async () => {
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
    const facts = { shipped: 54, closedUnshipped: 10, inFlight: 7, remaining: 3, total: 74 };
    await sendStakeholderReply({
      projectId: 'proj-1',
      text: 'Done: 54.',
      toolCalls: [],
      progress: facts,
      transport: ddpTransport() as never,
    });
    expect(screenStakeholderReply).toHaveBeenCalledWith('proj-1', 'Done: 54.', [], facts);
  });

  it('delivers over REST when the transport is rest', async () => {
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
    await sendStakeholderReply({
      projectId: 'proj-1',
      text: 'answer',
      toolCalls: [],
      progress: null,
      transport: restTransport() as never,
    });
    expect(postRoomMessage).toHaveBeenCalledWith(
      { serverUrl: 'https://chat.example.co', authToken: 'tok', userId: 'bot-1' },
      'room-1',
      'answer',
      undefined,
    );
  });
});

describe('sendFixedReply', () => {
  beforeEach(() => {
    screenStakeholderReply.mockReset();
    postRoomMessage.mockReset();
  });

  it('delivers verbatim without calling the guard when proof is FIXED_REPLY_CONSTANT', async () => {
    const transport = ddpTransport();
    await sendFixedReply(
      transport as never,
      'Sorry, overloaded right now.',
      FIXED_REPLY_CONSTANT as never,
    );
    expect(screenStakeholderReply).not.toHaveBeenCalled();
    expect(transport.client.sendMessage).toHaveBeenCalledWith(
      'room-1',
      'Sorry, overloaded right now.',
      undefined,
    );
  });

  it('delivers verbatim when proof is a verdict narrowed to ok:true (B3)', async () => {
    const transport = ddpTransport();
    await sendFixedReply(transport as never, 'Already-screened model reply.', {
      ok: true,
      problems: [],
    });
    expect(transport.client.sendMessage).toHaveBeenCalledWith(
      'room-1',
      'Already-screened model reply.',
      undefined,
    );
  });

  it('rejects delivery when proof is a verdict that is NOT ok (B3 runtime backstop)', async () => {
    const transport = ddpTransport();
    await expect(
      sendFixedReply(transport as never, 'Should never ship.', {
        ok: false,
        problems: ['leaks a code fence'],
      } as never),
    ).rejects.toThrow(/requires proof/);
    expect(transport.client.sendMessage).not.toHaveBeenCalled();
  });

  it('redacts the transport auth token if it appears in the text', async () => {
    const transport = ddpTransport({ authToken: 'super-secret-token' });
    await sendFixedReply(
      transport as never,
      'leaked super-secret-token in reply',
      FIXED_REPLY_CONSTANT as never,
    );
    const [, sentText] = transport.client.sendMessage.mock.calls[0] as [unknown, string];
    expect(sentText).not.toContain('super-secret-token');
  });

  it('clips a reply longer than the Rocket.Chat message-size ceiling', async () => {
    const transport = ddpTransport();
    await sendFixedReply(transport as never, 'x'.repeat(5000), FIXED_REPLY_CONSTANT as never);
    const [, sentText] = transport.client.sendMessage.mock.calls[0] as [unknown, string];
    expect(sentText.length).toBeLessThan(5000);
    expect(sentText).toMatch(/truncated/);
  });

  it('delivers over REST when the transport is rest', async () => {
    await sendFixedReply(restTransport() as never, 'fallback text', FIXED_REPLY_CONSTANT as never);
    expect(postRoomMessage).toHaveBeenCalledWith(
      { serverUrl: 'https://chat.example.co', authToken: 'tok', userId: 'bot-1' },
      'room-1',
      'fallback text',
      undefined,
    );
  });
});
