import type { agentSessions } from '../db/schema.js';
import { logger } from '../logger.js';

type SessionRow = typeof agentSessions.$inferSelect;

/**
 * One completion bridge: the metadata key that selects it, and how to reach it.
 */
export interface TerminalSessionBridge {
  /** The `metadata` key a session carries when this bridge owes it a delivery. */
  readonly marker: string;
  readonly deliver: (row: SessionRow) => Promise<void>;
}

/**
 * Every bridge fired when a session goes terminal.
 */
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

export function sessionCarriesBridgeMarker(metadata: unknown): boolean {
  const m = metadata as Record<string, unknown> | null;
  if (!m) return false;
  return TERMINAL_SESSION_BRIDGE_MARKERS.some((marker) => Boolean(m[marker]));
}

/**
 * Fire every bridge this session's metadata selects.
 */
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
export async function onTerminalPatch(updated: SessionRow): Promise<void> {
  await fireTerminalSessionBridges(updated);
}
