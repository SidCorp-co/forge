/**
 * ISS-1268 — a message sent into a session's running turn. The composer offers it while a turn
 * runs: `now` steers the turn (Claude Code ends the running reply and answers this message at
 * once), `next` answers it after the turn. Either way the box writes it into the running process's
 * stdin with its `priority` (`agent:steer`, `runner-agent/src/claude_code/control.rs`), so it never
 * starts a turn beside the one running.
 *
 * The message is the person's, so it is on the transcript where it was sent: a user entry and the
 * seed row the fold reads, at core's next seq, as a turn's own entry is (`chat-turn.ts:writeTurn`).
 * The running turn's lines numbered past it are numbered again from core's next seq (ISS-977).
 */

import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import type { agentSessions } from '../db/schema.js';
import { broadcastTurnAppended } from './broadcast.js';
import { requireListeningBox } from './chat-device.js';
import { agentSessionsPorts } from './ports.js';
import { refuseSession } from './refusals.js';
import { seedTurn } from './session-events.js';
import { readTranscript, type TranscriptEntry, writeTranscript } from './turns-helpers.js';

type AgentSessionRow = typeof agentSessions.$inferSelect;

export type SteerPriority = 'now' | 'next';

/** The box a session's turn runs on. */
export function boxOf(session: { deviceId: string | null; metadata: unknown }): string | null {
  return (session.metadata as { deviceId?: string } | null)?.deviceId ?? session.deviceId ?? null;
}

export async function steerRunningTurn(args: {
  session: AgentSessionRow;
  message: string;
  priority: SteerPriority;
  attachmentIds: readonly string[];
}): Promise<void> {
  const { session, message, priority } = args;
  if (args.attachmentIds.length > 0) {
    throw refuseSession(
      'STEER_ATTACHMENTS_UNSUPPORTED',
      `a message sent into session ${session.id}'s running turn carries text only; send the ${args.attachmentIds.length} file(s) once the turn ends`,
    );
  }
  const deviceId = boxOf(session);
  if (!deviceId) {
    throw refuseSession('NO_DEVICE', `session ${session.id} runs a turn on no recorded box`);
  }
  requireListeningBox(deviceId);
  const now = new Date();
  const entry: TranscriptEntry = {
    id: randomUUID(),
    type: 'user',
    content: message,
    timestamp: now.getTime(),
  };
  const { appended } = await db.transaction(async (tx) => {
    const prev = await readTranscript(session.id, tx);
    const written = await writeTranscript(tx, session.id, [...prev, entry], prev);
    await seedTurn(tx, session.id, { priorMessages: [], entry, at: now });
    return written;
  });
  for (const t of appended) broadcastTurnAppended(session, t);
  const reached = agentSessionsPorts().sendToBoxNow(deviceId, {
    event: 'agent:steer',
    data: { sessionId: session.id, message, priority },
  });
  if (reached === 0) {
    throw refuseSession(
      'NO_LIVE_SESSION',
      `session ${session.id}'s box ${deviceId} stopped listening before the message reached it`,
    );
  }
}
