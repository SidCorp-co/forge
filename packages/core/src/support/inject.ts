// A message that arrives while the session's turn runs is written into that turn at once
// (REQ-75 BC-11), through the session inbox every live session takes input by (RFC 0003,
// `agent-sessions/session-send.ts`). The box writes it into the resident Claude Code process's
// stdin, and Claude Code 2.1.310 takes it into the running turn at its next tool call, or answers
// it as a turn of its own straight after the running turn's result; the box ends the turn only
// once nothing it wrote is still queued. A box that holds no turn for the session refuses the
// write, and the sweep below gives the messages back for the next turn.

import {
  requestSessionSend,
  sessionRowById,
  sessionSendStanding,
} from '../agent-sessions/index.js';
import { logger } from '../lib/logger.js';
import {
  claimUndelivered,
  giveBackInjected,
  markDelivery,
  roomOfAction,
  settleInjected,
  unclaim,
  unsettledInjects,
} from './delivery.js';
import { type DeliverOutcome, deliverWaiting, type SessionRow } from './dispatch.js';
import { turnMessages } from './prompt.js';
import { type RoomRow, roomById } from './store.js';

const INJECT_LEAD = 'More messages arrived in the group while you were working:';

/** The prefix of every write the support domain makes into a running turn. */
export const INJECT_INTENT = 'support:';

/** Write every message waiting in `room` into its session's running turn. */
export async function injectWaiting(room: RoomRow, session: SessionRow): Promise<DeliverOutcome> {
  if (!session.deviceId) return 'turn-running';
  const at = new Date();
  const rows = await claimUndelivered(room.id, at);
  const [first] = rows;
  if (!first) return 'nothing-waiting';
  const ids = rows.map((r) => r.id);
  try {
    const sent = await requestSessionSend({
      agentSessionId: session.id,
      kind: 'inject',
      intentId: `${INJECT_INTENT}${first.id}`,
      body: `${INJECT_LEAD}\n\n${turnMessages(rows)}`,
    });
    if (!sent.published) {
      await unclaim(ids, at);
      return 'turn-running';
    }
    await markDelivery(ids, { path: 'inject', injectSeq: sent.row.seq });
    return 'injected';
  } catch (err) {
    logger.error(
      { err, roomId: room.id, sessionId: session.id },
      'support: a message could not be written into the running turn; it waits for the next',
    );
    await unclaim(ids, at);
    return 'turn-running';
  }
}

/**
 * What became of each message written into a running turn: one the box took, or a completed turn
 * applied, is settled; one the box refused (no turn in flight there), or that nobody answered for
 * past the send deadline, goes back to wait for the next turn. Read as a room's turn ends, and by
 * the recovery sweep for every room. Returns the rooms given messages back.
 */
export async function settleInjects(roomId?: string): Promise<string[]> {
  const back = new Set<string>();
  for (const row of await unsettledInjects(roomId)) {
    const seq = (row.output as { injectSeq?: unknown } | null)?.injectSeq;
    const room = await roomById(row.roomId);
    if (typeof seq !== 'number' || !room?.sessionId) continue;
    const standing = await sessionSendStanding(room.sessionId, seq);
    if (!standing) continue;
    if (standing.applied || standing.confirmed === 'delivered') {
      await settleInjected([row.id]);
    } else if (standing.outcome === 'gone' || standing.outcome === 'undelivered') {
      await giveBackInjected([row.id]);
      back.add(row.roomId);
    }
  }
  return [...back];
}

/**
 * The box refused a write: its turn had ended (Claude Code answered) before core read the session
 * as ended. Once core reads it ended the messages go at once as a turn of their own; while it still
 * reads running, that turn's end settles them (`dispatch.ts:onSupportTurnEnded`), so a refusal and a
 * turn end arriving in either order hand the messages on without waiting for the sweep.
 */
export async function onInjectRefused(refused: { intentId: string }, tries = 0): Promise<void> {
  const roomId = await roomOfAction(refused.intentId.slice(INJECT_INTENT.length));
  if (!roomId) return;
  const room = await roomById(roomId);
  const session = room?.sessionId ? await sessionRowById(room.sessionId) : null;
  if (!session) return;
  if (session.status === 'running') {
    // the turn's end may be committing as the refusal lands, or its bridge already ran: read again
    // until core reads it ended, for as long as the 2 s recovery sweep would otherwise take
    if (tries < RECHECKS) {
      setTimeout(
        () => void onInjectRefused(refused, tries + 1).catch(() => {}),
        RECHECK_MS,
      ).unref();
    }
    return;
  }
  await settleInjects(roomId);
  await deliverWaiting(roomId);
}

/** How often, and how many times, a refusal that found the turn still running reads it again. */
const RECHECK_MS = 250;
const RECHECKS = 8;
