// cm:guard ISS-671 — the ONE door to a Rocket.Chat room, and outbound.test.ts makes that structural: it fails CI if any file in this directory other than this one, rest-client.ts or ddp-client.ts calls postRoomMessage( or .sendMessage(, because a new reply path that forgot redact/clip or the output guard entirely used to compile and ship silently

import { scrubLogText } from '@forge/observability';
import type { ProvenMessage } from '../../messaging/proven.js';
import type { RocketChatDdpClient } from './ddp-client.js';
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

async function deliver(transport: ReplyTransport, text: string): Promise<string | null> {
  const safe = scrubLogText(clipReply(text), [transportAuthToken(transport)]);
  if (transport.kind === 'ddp') {
    return transport.client.sendMessage(transport.rid, safe, transport.tmid);
  }
  return postRoomMessage(transport.auth, transport.rid, safe, transport.tmid);
}

export const FIXED_REPLY_CONSTANT: unique symbol = Symbol('rocketchat.outbound.fixedReplyConstant');

/**
 * What this door accepts as evidence that the string it is about to post may be posted.
 */
// cm:guard FIXED_REPLY_CONSTANT is for code-authored text only (an ack, an honest fallback); model text
// requires a `ProvenMessage`, which is NOMINAL — `messaging/proven.ts` holds the only mint and the
// brand is a private symbol, so there is no third way to satisfy `proof` and a reply path that forgot
// to screen fails to compile rather than shipping. Until ISS-978 this arm read `{ ok: true; problems:
// string[] }`, which every object of that shape satisfied: five producers hand-built one, so the
// compile-time guarantee this guard claimed was true of none of them.
export type ReplySendProof = typeof FIXED_REPLY_CONSTANT | ProvenMessage;

// cm:guard the proof names the EXACT string it was minted for and this door compares it against what it
// is being asked to send, because a proof that merely accompanies a message proves nothing about that
// message: the second half of ISS-978 F5 was a screen run over a round's option labels while the
// rendered round went out beside it. A mismatch is refused BY NAME rather than posted, and the refusal
// quotes both strings so the caller can see which two it paired.
// cm:why the comparison is against the text as the caller wrote it, BEFORE `deliver` scrubs and clips
// it: those two are this codebase's own edits to its own outgoing byte stream, not a change of message,
// and a screen cannot be expected to have judged a string that does not exist until the door makes it.
// cm:guard the receipt is the id of the message that was POSTED, and `null` means the transport took the text without naming one — a caller storing a thread id must treat that as an undelivered round rather than inventing one (ISS-978 criterion 8).
export async function sendFixedReply(
  transport: ReplyTransport,
  text: string,
  proof: ReplySendProof,
): Promise<{ messageId: string | null }> {
  if (proof !== FIXED_REPLY_CONSTANT) {
    // cm:guard the two refusals are SEPARATE because they are different mistakes and a reader fixes
    // them differently: the first is a proof that never came from a screen (only reachable from
    // JavaScript or through a cast, since the type forbids it), the second is a real proof paired with
    // a message it was not minted for. Collapsing them into one sentence sends whoever hits the second
    // one looking for a missing screen that is already there (ISS-978 F5).
    if (typeof proof.text !== 'string') {
      throw new Error(
        `outbound: this proof did not come from a screen — it names no string it was minted for. A model-text reply is posted under the value \`messaging/proven.ts\` returns, and code-authored text under FIXED_REPLY_CONSTANT. Got: ${JSON.stringify(proof)}.`,
      );
    }
    if (proof.text !== text) {
      throw new Error(
        `outbound: this proof was minted at the "${proof.door}" door for a different string than the one being posted. Screened: ${JSON.stringify(quoted(proof.text))}. Being sent: ${JSON.stringify(quoted(text))}. Screen the exact string you are posting, or post it under FIXED_REPLY_CONSTANT if this codebase wrote it.`,
      );
    }
  }
  return { messageId: await deliver(transport, text) };
}

const quoted = (s: string): string => (s.length > 120 ? `${s.slice(0, 120)}…` : s);
