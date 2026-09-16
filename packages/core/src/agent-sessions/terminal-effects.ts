/**
 * What a session owes when it goes terminal, and the one list that says so.
 *
 * There are two terminal writers and neither is sufficient alone, and the split
 * is not a design choice: `PATCH /api/agent-sessions/:id` writes `patch.status`,
 * a variable, so `lifecycle/transition.ts`'s guard test cannot see it and never
 * will. What ISS-1039 removes is the second copy of the LIST — each writer used
 * to name every bridge by hand, so a third one was two edits in two files with
 * no gate to catch a forgotten half. The list is data now, and both writers
 * loop over it.
 */

import type { agentSessions } from '../db/schema.js';
import { logger } from '../logger.js';

type SessionRow = typeof agentSessions.$inferSelect;

/**
 * One completion bridge: the metadata key that selects it, and how to reach it.
 */
// cm:guard the module is behind a dynamic `import()` and not a static one, which is what keeps this file importable from `lifecycle/transition.ts` without dragging an integration tree into the kernel's own module graph.
export interface TerminalSessionBridge {
  /** The `metadata` key a session carries when this bridge owes it a delivery. */
  readonly marker: string;
  readonly deliver: (row: SessionRow) => Promise<void>;
}

/**
 * Every bridge fired when a session goes terminal.
 */
// cm:edge lockstep -> packages/core/src/lifecycle/transition.ts — that chokepoint gates on `TERMINAL_SESSION_BRIDGE_MARKERS` and fires through `fireTerminalSessionBridges`, so a bridge added here is live at BOTH writers with no second edit. That is the property ISS-1039 bought; a bridge added by editing either writer instead is the thing it removed.
export const TERMINAL_SESSION_BRIDGES: readonly TerminalSessionBridge[] = [
  {
    marker: 'escalation',
    deliver: async (row) =>
      (await import('../integrations/rocketchat/escalation-bridge.js')).deliverEscalationReplyOnce(
        row,
      ),
  },
  {
    marker: 'conversationAgent',
    deliver: async (row) =>
      (await import('./conversation-agent-bridge.js')).deliverConversationAgentReplyOnce(row),
  },
  {
    // cm:hack ISS-1039 until: no `agent_sessions` row with a non-terminal status carries a `metadata.agentChat` key — then delete this entry and `integrations/rocketchat/legacy-agent-chat-bridge.ts` with it.
    // cm:guard the price: one extra reader, for the Rocket.Chat sessions dispatched under ISS-727's metadata shape that are still running when this deploys. Their rows name a connection, a room and a thread and no venue, so the neutral bridge cannot read them and the room would simply never be answered. It buys the deploy and nothing else — nothing new is ever written under this marker.
    marker: 'agentChat',
    deliver: async (row) =>
      (
        await import('../integrations/rocketchat/legacy-agent-chat-bridge.js')
      ).deliverLegacyAgentChatReplyOnce(row),
  },
];

/** The markers a terminal writer gates on before it hydrates a row for the bridges. */
export const TERMINAL_SESSION_BRIDGE_MARKERS: readonly string[] = TERMINAL_SESSION_BRIDGES.map(
  (b) => b.marker,
);

/** Whether any bridge owes this session's metadata a delivery. */
export function sessionCarriesBridgeMarker(metadata: unknown): boolean {
  const m = metadata as Record<string, unknown> | null;
  if (!m) return false;
  return TERMINAL_SESSION_BRIDGE_MARKERS.some((marker) => Boolean(m[marker]));
}

/**
 * Fire every bridge this session's metadata selects.
 */
// cm:guard best-effort per bridge and it MUST stay that way: both writers call this after the terminal flip has committed, so a throw would take a sweeper's whole pass down AFTER its rows went terminal — the broadcasts and wedges for every row it had already flipped would never fire, and the next tick would not find those rows again.
// cm:why the runner's PATCH awaits this and the kernel chokepoint does not: the PATCH is one row and its caller is a request, while the chokepoint can be sweeping hundreds and must not hold a transaction's caller open behind a REST post.
export async function fireTerminalSessionBridges(row: SessionRow): Promise<void> {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  for (const bridge of TERMINAL_SESSION_BRIDGES) {
    if (!metadata[bridge.marker]) continue;
    try {
      await bridge.deliver(row);
    } catch (err) {
      logger.error(
        { err, sessionId: row.id, marker: bridge.marker },
        'agent-sessions: a terminal-session bridge failed',
      );
    }
  }
}

/**
 * What a session owes when it goes terminal through the runner's own PATCH.
 */
// cm:edge lockstep -> packages/core/src/lifecycle/transition.ts — the chokepoint's `entity === 'session'` branch is the other half. Both now go through the one list above, so what still has to be kept in step is the CALL and no longer its contents.
export async function onTerminalPatch(updated: SessionRow): Promise<void> {
  await fireTerminalSessionBridges(updated);
}
