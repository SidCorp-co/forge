import type { agentSessions } from '../db/schema.js';
import { logger } from '../lib/logger.js';

type SessionRow = typeof agentSessions.$inferSelect;

/** How one completion bridge delivers a terminal session's reply. */
type TerminalSessionDelivery = (row: SessionRow) => Promise<void>;

/**
 * The metadata key each completion bridge is selected by, in firing order. A terminal writer gates
 * on these before it hydrates a row; the delivery behind each is handed in by the module that owns
 * it, so the kernel imports no chat application.
 */
const TERMINAL_SESSION_BRIDGE_MARKERS = ['escalation', 'conversationAgent'] as const;
type TerminalSessionBridgeMarker = (typeof TERMINAL_SESSION_BRIDGE_MARKERS)[number];

const deliveries = new Map<TerminalSessionBridgeMarker, TerminalSessionDelivery>();

/** Registers the delivery behind one marker. Called once at boot by the module that owns it. */
export function provideTerminalSessionBridge(
  marker: TerminalSessionBridgeMarker,
  deliver: TerminalSessionDelivery,
): void {
  deliveries.set(marker, deliver);
}

export function sessionCarriesBridgeMarker(metadata: unknown): boolean {
  const m = metadata as Record<string, unknown> | null;
  if (!m) return false;
  return TERMINAL_SESSION_BRIDGE_MARKERS.some((marker) => Boolean(m[marker]));
}

/**
 * Fire every bridge this session's metadata selects. The token the session was handed is revoked
 * by the status write itself (migration 0324), not here.
 */
export async function fireTerminalSessionBridges(row: SessionRow): Promise<void> {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  for (const marker of TERMINAL_SESSION_BRIDGE_MARKERS) {
    if (!metadata[marker]) continue;
    const deliver = deliveries.get(marker);
    if (!deliver) {
      logger.error(
        { sessionId: row.id, marker },
        'agent-sessions: a session carries a bridge marker no module registered a delivery for; its reply is not delivered',
      );
      continue;
    }
    try {
      await deliver(row);
    } catch (err) {
      logger.error(
        { err, sessionId: row.id, marker },
        'agent-sessions: a terminal-session bridge failed',
      );
    }
  }
}
