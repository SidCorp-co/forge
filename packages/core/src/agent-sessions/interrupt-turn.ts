/**
 * ISS-1268 — Stop: the stream-json `interrupt` control request written into a session's running
 * turn on its box (`runner-agent/src/claude_code/control.rs`). The turn ends with its `result` and
 * closes as every turn does, so the session keeps its process and the next message continues it.
 * Nothing here kills a process or moves the session.
 *
 * Who may stop is the caller's to check: a session's owner at `POST /agent-sessions/:id/interrupt`,
 * a room's writers at `POST /conversations/:id/stop` for the Agent turn it runs.
 */

import { agentSessionsPorts } from './ports.js';
import { refuseSession } from './refusals.js';
import { boxOf } from './steer-turn.js';

export function interruptRunningTurn(session: {
  id: string;
  status: string;
  deviceId: string | null;
  metadata: unknown;
}): void {
  if (session.status !== 'running') {
    throw refuseSession(
      'SESSION_NOT_RUNNING',
      `session ${session.id} is ${session.status}, so it has no turn to stop`,
    );
  }
  const deviceId = boxOf(session);
  const reached = deviceId
    ? agentSessionsPorts().sendToBoxNow(deviceId, {
        event: 'agent:interrupt',
        data: { sessionId: session.id },
      })
    : 0;
  if (reached === 0) {
    throw refuseSession(
      'NO_LIVE_SESSION',
      `session ${session.id}'s box ${deviceId ?? '(none recorded)'} is not connected, so its turn cannot be stopped from here`,
    );
  }
}
