/**
 * ISS-671 — the ONE door to a Rocket.Chat room. Every reply path
 * (sync mention-reply, the escalation bridge, the agent-chat bridge, the
 * agent-chat delayed ack) used to call `DdpClient.sendMessage`/
 * `postRoomMessage` directly, each re-implementing the same redact+clip step
 * — so a new reply path that forgot to redact/clip, or forgot the output
 * guard entirely, compiled and shipped silently (AC#1's "must not be able to
 * forget the guard"). `outbound.test.ts` turns that into a structural
 * failure: it fails CI if any file in this directory other than this one,
 * `rest-client.ts`, or `ddp-client.ts` calls `postRoomMessage(`/`.sendMessage(`.
 *
 * `sendStakeholderReply` screens fresh, not-yet-verified text through
 * `screenStakeholderReply` before delivering. `sendFixedReply` is for
 * delivering a decision a caller already made (a code-authored fallback
 * constant, or model text it already holds a passing verdict for) — its
 * required `proof` argument closes the B3 gap where that decision used to be
 * unenforced convention: `FIXED_REPLY_CONSTANT` for the former, or the
 * `{ok:true}`-narrowed `ReplyScreenVerdict` for the latter, so a 5th path
 * that forgets to screen model text fails to type-check instead of shipping.
 */

import { scrubLogText } from '@forge/observability';
import type { RocketChatDdpClient } from './ddp-client.js';
import type { ProgressFacts } from './reply-guard.js';
import { screenStakeholderReply } from './reply-screen.js';
import { postRoomMessage } from './rest-client.js';
import type { RoomPostAuth } from './room-delivery.js';

export type ReplyTransport =
  | {
      kind: 'ddp';
      client: RocketChatDdpClient;
      rid: string;
      tmid?: string | undefined;
      authToken: string;
    }
  | { kind: 'rest'; auth: RoomPostAuth; rid: string; tmid?: string | undefined };

// cm:why Rocket.Chat rejects messages over `Message_MaxAllowedSize` (default 5000) outright — truncate below that so the user isn't left in silence
const MAX_REPLY_CHARS = 4500;

function clipReply(text: string): string {
  return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}… [truncated]` : text;
}

function transportAuthToken(transport: ReplyTransport): string {
  return transport.kind === 'ddp' ? transport.authToken : transport.auth.authToken;
}

async function deliver(transport: ReplyTransport, text: string): Promise<void> {
  const safe = scrubLogText(clipReply(text), [transportAuthToken(transport)]);
  if (transport.kind === 'ddp') {
    await transport.client.sendMessage(transport.rid, safe, transport.tmid);
  } else {
    await postRoomMessage(transport.auth, transport.rid, safe, transport.tmid);
  }
}

/**
 * Screens, then delivers. Returns `{ sent: false, problems }` WITHOUT
 * sending when the guard rejects — the caller owns the corrective retry,
 * then calls {@link sendFixedReply} with the honest fallback.
 */
export async function sendStakeholderReply(args: {
  projectId: string;
  text: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  progress?: ProgressFacts | null;
  transport: ReplyTransport;
}): Promise<{ sent: true } | { sent: false; problems: string[] }> {
  if (!args.text.trim()) return { sent: false, problems: ['empty reply'] };
  const verdict = await screenStakeholderReply(
    args.projectId,
    args.text,
    args.toolCalls,
    args.progress,
  );
  if (!verdict.ok) return { sent: false, problems: verdict.problems };
  await deliver(args.transport, args.text);
  return { sent: true };
}

/** Pass this as `sendFixedReply`'s `proof` for a genuine code-authored
 *  constant (ack, honest fallback) — never for model-generated text. */
export const FIXED_REPLY_CONSTANT: unique symbol = Symbol('rocketchat.outbound.fixedReplyConstant');

/** Either {@link FIXED_REPLY_CONSTANT}, or a `ReplyScreenVerdict` narrowed to
 *  `ok: true` for the exact text being sent — see {@link sendFixedReply}. */
export type ReplySendProof = typeof FIXED_REPLY_CONSTANT | { ok: true; problems: string[] };

/**
 * `proof` must be either {@link FIXED_REPLY_CONSTANT} or a
 * `ReplyScreenVerdict` narrowed to `ok: true` for THIS `text` — i.e. the
 * caller just ran `if (verdict.ok) { ... }` and is inside that block. There
 * is no third way to satisfy this parameter, so a reply path that forgot to
 * screen model text (B3) fails to compile instead of shipping unguarded.
 */
export async function sendFixedReply(
  transport: ReplyTransport,
  text: string,
  proof: ReplySendProof,
): Promise<void> {
  if (proof !== FIXED_REPLY_CONSTANT && !proof.ok) {
    throw new Error(
      'outbound: sendFixedReply requires proof text is a fixed constant or passed the output guard',
    );
  }
  await deliver(transport, text);
}
