// A chat's write to a record route waits until the person it answers agrees (REQ-30 BC-4, workflow
// chat-turn step write). Each record route names what it writes; the hold that decides is the
// assistant domain's, which this platform module may not import, so the process entry provides it
// at boot. It runs after the route's own validators, so a malformed body is refused by its own name
// rather than held, and before the handler, so a held write never reaches the service.

import type { ChatProposalKind } from '@forge/contracts/chat-proposals';
import type { Context, MiddlewareHandler } from 'hono';

/** Throws the refusal that holds the write, or returns to let the request through. */
export type ChatWriteHold = (c: Context, kind: ChatProposalKind) => Promise<void>;

let provided: ChatWriteHold | null = null;

export function provideChatWriteHold(hold: ChatWriteHold): void {
  provided = hold;
}

/** The middleware a record route puts before its handler, naming what it writes. */
export function holdChatWrite(kind: ChatProposalKind): MiddlewareHandler {
  return async (c, next) => {
    if (!provided) {
      throw new Error(
        'chat write hold: none was provided, so a chat credential would write unheld; the process entry calls provideChatWriteHold before it serves',
      );
    }
    await provided(c, kind);
    await next();
  };
}
