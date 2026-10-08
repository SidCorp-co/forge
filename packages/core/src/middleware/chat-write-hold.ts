// A chat's write waits until the person it answers agrees (REQ-30 BC-4, workflow chat-turn r3 step
// hold), and holding is the default rather than a route's opt-in. Every write request a PAT is
// admitted on meets `admitChatWrite` (`auth.ts:admitPat`), which reads the route it matched: a route
// whose handlers carry `holdChatWrite(kind)` is left to that hold, and any other write a chat
// credential sends is passed or refused by the one rule the assistant domain keeps
// (`assistant/agreement/write-rule.ts`). That domain may not be imported by this platform module, so
// the process entry provides both halves at boot.
//
// The route hold runs after the route's own validators, so a malformed body is refused by its own
// name rather than held, and before the handler, so a held write never reaches the service.

import type { ChatProposalKind } from '@forge/contracts/chat-proposals';
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { findTargetHandler } from 'hono/utils/handler';
import type { ToolGrantEntry } from '../lib/tool.js';
import { registrationServes, scopeForMethod } from './pat-rest-surface.js';

/** A write request as the chat write rule reads it: the pattern it matched and the kind its hold names. */
export interface ChatWriteRoute {
  readonly method: string;
  readonly route: string;
  readonly heldAs: ChatProposalKind | null;
}

export interface ChatWriteHold {
  /** Throws the refusal that holds the write, or returns to let the request through. */
  hold: (c: Context, kind: ChatProposalKind) => Promise<void>;
  /** Throws the refusal of a write no hold names and no list passes, or returns to let it through. */
  admit: (c: Context, route: ChatWriteRoute) => Promise<void>;
  /** The refusal of a tool call over /mcp that no list passes, or null to let it run. */
  tool: (
    name: string,
    args: Record<string, unknown>,
    grant: ToolGrantEntry | null,
  ) => Promise<string | null>;
}

let provided: ChatWriteHold | null = null;

export function provideChatWriteHold(hold: ChatWriteHold): void {
  provided = hold;
}

function providedHold(): ChatWriteHold {
  if (!provided) {
    throw new Error(
      'chat write hold: none was provided, so a chat credential would write unheld; the process entry calls provideChatWriteHold before it serves',
    );
  }
  return provided;
}

const HOLDS = Symbol('chat write hold');
type HoldMiddleware = MiddlewareHandler & { [HOLDS]?: ChatProposalKind };

/** The middleware a record route puts before its handler, naming what it writes. */
export function holdChatWrite(kind: ChatProposalKind): MiddlewareHandler {
  const middleware: HoldMiddleware = async (c, next) => {
    await providedHold().hold(c, kind);
    await next();
  };
  middleware[HOLDS] = kind;
  return middleware;
}

type Registration = Parameters<typeof registrationServes>[0] & { path: string };

const holdKindOf = (r: Registration): ChatProposalKind | null =>
  (findTargetHandler(r.handler) as HoldMiddleware)[HOLDS] ?? null;

/** The route a request matched, read from the router: its pattern, and the kind its own hold names. */
export function chatWriteRouteOf(c: Context): ChatWriteRoute {
  const matched = matchedRoutes(c) as Registration[];
  const target = matched.find(registrationServes);
  if (!target) return { method: c.req.method, route: c.req.path, heldAs: null };
  const own = matched.filter((r) => r.method === target.method && r.path === target.path);
  const heldAs = own.map(holdKindOf).find((k) => k !== null) ?? null;
  return { method: c.req.method, route: target.path, heldAs };
}

const ADMITTED = 'chatWriteAdmitted';

/**
 * The default every write a PAT is admitted on meets, once per request however many routers gate
 * it: a chat credential's write is held where its route's hold names it, passed where the rule names
 * it as not a business write, and refused by name otherwise. A read is never asked.
 */
export async function admitChatWrite(c: Context): Promise<void> {
  if (scopeForMethod(c.req.method) === 'read' || c.get(ADMITTED)) return;
  await providedHold().admit(c, chatWriteRouteOf(c));
  c.set(ADMITTED, true);
}

/** The /mcp half: a chat credential's tool call that writes is refused by name, unless the rule passes it. */
export function chatToolWriteRefusal(
  name: string,
  args: Record<string, unknown>,
  grant: ToolGrantEntry | null,
): Promise<string | null> {
  return providedHold().tool(name, args, grant);
}
