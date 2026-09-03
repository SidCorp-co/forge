// cm:guard ISS-671 — the ONE door to a Rocket.Chat room, and outbound.test.ts makes that structural: it fails CI if any file in this directory other than this one, rest-client.ts or ddp-client.ts calls postRoomMessage( or .sendMessage(, because a new reply path that forgot redact/clip or the output guard entirely used to compile and ship silently

import { scrubLogText } from '@forge/observability';
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

async function deliver(transport: ReplyTransport, text: string): Promise<void> {
  const safe = scrubLogText(clipReply(text), [transportAuthToken(transport)]);
  if (transport.kind === 'ddp') {
    await transport.client.sendMessage(transport.rid, safe, transport.tmid);
  } else {
    await postRoomMessage(transport.auth, transport.rid, safe, transport.tmid);
  }
}

export const FIXED_REPLY_CONSTANT: unique symbol = Symbol('rocketchat.outbound.fixedReplyConstant');

export type ReplySendProof = typeof FIXED_REPLY_CONSTANT | { ok: true; problems: string[] };

// cm:guard FIXED_REPLY_CONSTANT is for code-authored text only (an ack, an honest fallback); model text requires a ReplyScreenVerdict narrowed to ok:true for THAT exact string. There is no third way to satisfy `proof`, which is what makes a reply path that forgot to screen (B3) fail to compile rather than ship
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
