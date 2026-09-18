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
      `A reply path is calling the RC send primitive directly instead of going through outbound.ts (sendFixedReply). Offending files:\n${violations.join('\n')}`,
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

const screenRoomReply = vi.fn();
vi.mock('../../messaging/reply-screen.js', () => ({
  screenReplyAtDoor: (...args: unknown[]) => screenRoomReply(...args),
}));

const postRoomMessage = vi.fn();
vi.mock('./rest-client.js', () => ({
  postRoomMessage: (...args: unknown[]) => postRoomMessage(...args),
}));

const { FIXED_REPLY_CONSTANT, sendFixedReply } = await import('./outbound.js');
const { proven, wholeAgentText } = await import('../../messaging/proven.js');
const { screenAtDoor } = await import('../../messaging/screen.js');

/** A real proof: the screen runs, and its verdict is the only thing that can mint one. */
function mint(text: string) {
  const admitted = proven(
    'question-delivery',
    wholeAgentText(text),
    screenAtDoor('question-delivery', [text]),
  );
  if (!admitted) throw new Error(`the fixture text did not pass the screen: ${text}`);
  return admitted;
}

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

describe('sendFixedReply', () => {
  beforeEach(() => {
    screenRoomReply.mockReset();
    postRoomMessage.mockReset();
  });

  it('delivers verbatim without calling the guard when proof is FIXED_REPLY_CONSTANT', async () => {
    const transport = ddpTransport();
    await sendFixedReply(
      transport as never,
      'Sorry, overloaded right now.',
      FIXED_REPLY_CONSTANT as never,
    );
    expect(screenRoomReply).not.toHaveBeenCalled();
    expect(transport.client.sendMessage).toHaveBeenCalledWith(
      'room-1',
      'Sorry, overloaded right now.',
      undefined,
    );
  });

  it('delivers verbatim when proof is a ProvenMessage the screen minted for that string', async () => {
    const transport = ddpTransport();
    const admitted = mint('Already-screened model reply.');
    await sendFixedReply(transport as never, admitted.text, admitted);
    expect(transport.client.sendMessage).toHaveBeenCalledWith(
      'room-1',
      'Already-screened model reply.',
      undefined,
    );
  });

  // cm:guard TWO assertions on one call, and both are load-bearing (ISS-978 F5). The
  // `@ts-expect-error` is the compile-time half: `ReplySendProof`'s model arm is nominal, so a
  // hand-built literal must not typecheck — and if the brand is ever removed the literal compiles, the
  // directive becomes unused, and `tsc` fails with TS2578. That is the only thing that can turn this
  // line red, which is what makes it evidence rather than decoration: the runtime half below cannot
  // tell a forged proof from a real one on its own, because before the brand every literal of this
  // shape WAS a valid proof and the union could not distinguish them.
  it('refuses a hand-built proof — and one does not even typecheck', async () => {
    const transport = ddpTransport();
    await expect(
      // @ts-expect-error ISS-978 F5: `{ ok: true; problems: string[] }` is not a ProvenMessage, and the
      // point of branding the type is that this line stops compiling. Removing the brand makes this
      // directive unused and fails the build.
      sendFixedReply(transport as never, 'Should never ship.', { ok: true, problems: [] }),
    ).rejects.toThrow(/did not come from a screen/);
    expect(transport.client.sendMessage).not.toHaveBeenCalled();
  });

  // cm:guard the discriminating half: a proof is a claim about ONE string, so a real proof paired with
  // a different message has to be refused as loudly as a forged one. Before ISS-978 nothing compared
  // the two at all — the delivery lane screened a round's option labels and posted the rendered round,
  // and this door accepted it because the verdict merely accompanied the text.
  it('refuses a real proof minted for a different string, naming both', async () => {
    const transport = ddpTransport();
    const admitted = mint('the answer the screen read');
    await expect(
      sendFixedReply(transport as never, 'a different message entirely', admitted),
    ).rejects.toThrow(/the answer the screen read[\s\S]*a different message entirely/);
    expect(transport.client.sendMessage).not.toHaveBeenCalled();
  });

  it('posts a proof whose text matches, so the comparison is not refusing everything', async () => {
    const transport = ddpTransport();
    const admitted = mint('a message that matches its proof');
    await expect(
      sendFixedReply(transport as never, admitted.text, admitted),
    ).resolves.toMatchObject({ messageId: undefined });
    expect(transport.client.sendMessage).toHaveBeenCalled();
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
