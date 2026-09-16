
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

export type ReplySendProof = typeof FIXED_REPLY_CONSTANT | { ok: true; problems: string[] };

export async function sendFixedReply(
  transport: ReplyTransport,
  text: string,
  proof: ReplySendProof,
): Promise<{ messageId: string | null }> {
  if (proof !== FIXED_REPLY_CONSTANT && !proof.ok) {
    throw new Error(
      'outbound: sendFixedReply requires proof text is a fixed constant or passed the output guard',
    );
  }
  return { messageId: await deliver(transport, text) };
}
