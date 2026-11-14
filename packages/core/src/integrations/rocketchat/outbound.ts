import type { ProvenMessage } from '@forge/contracts/messaging';
import { scrubLogText } from '@forge/observability';
import type { RocketChatDdpClient } from './ddp-client.js';
import { postRoomMessage, type RocketChatButtonAttachment } from './rest-client.js';
import type { RoomPostAuth } from './room-auth.js';
import { type MessageChange, updateRoomMessage } from './room-media.js';

export type ReplyTransport =
  | {
      kind: 'ddp';
      client: RocketChatDdpClient;
      rid: string;
      tmid?: string | undefined;
      authToken: string;
    }
  | {
      kind: 'rest';
      auth: RoomPostAuth;
      rid: string;
      tmid?: string | undefined;
      /** Buttons posted under the text, code-authored like it (a support fix's confirm). */
      attachments?: readonly RocketChatButtonAttachment[] | undefined;
    };

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
  return postRoomMessage(
    transport.auth,
    transport.rid,
    safe,
    transport.tmid,
    transport.attachments,
  );
}

export const FIXED_REPLY_CONSTANT: unique symbol = Symbol('rocketchat.outbound.fixedReplyConstant');

/**
 * What this door accepts as evidence that the string it is about to post may be posted.
 */
export type ReplySendProof = typeof FIXED_REPLY_CONSTANT | ProvenMessage;

/** Throws unless `proof` is the constant or a screen's proof minted for exactly `text`. */
function assertProven(text: string, proof: ReplySendProof): void {
  if (proof !== FIXED_REPLY_CONSTANT) {
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
}

export async function sendFixedReply(
  transport: ReplyTransport,
  text: string,
  proof: ReplySendProof,
): Promise<{ messageId: string | null }> {
  assertProven(text, proof);
  return { messageId: await deliver(transport, text) };
}

/**
 * Replace the text of a message the bot posted (ISS-1238), held to the proof a new line is: an edit
 * never carries words the screen did not admit, nor the bot's own token.
 */
export async function editProvenReply(
  auth: RoomPostAuth,
  rid: string,
  messageId: string,
  text: string,
  proof: ProvenMessage,
): Promise<MessageChange> {
  assertProven(text, proof);
  const safe = scrubLogText(clipReply(text), [auth.authToken]);
  return updateRoomMessage(auth, rid, messageId, safe);
}

const quoted = (s: string): string => (s.length > 120 ? `${s.slice(0, 120)}…` : s);
