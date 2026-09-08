// Stopping a session, whether or not there is a process to stop.
//
// A stop delivered as a message is a request the agent may honour. This one is
// the record: the session row reaches terminal and every question it was
// waiting on is voided by name, so a session whose process died mid-park does
// not stay live forever (ISS-964 criterion 17).

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { agentQuestions } from '../db/schema-questions.js';

export async function stopSession(args: { agentSessionId: string; by: string; reason: string }) {
  // cm:guard the record moves FIRST and unconditionally — no liveness check, no process lookup, no delivery attempt. Whether a process exists is exactly what a stop cannot know, and gating the write on it is how a stop becomes a request (ISS-964 criterion 17).
  // cm:guard the two writes are ONE transaction under the kernel marker, or migration 0219's triggers file this stop in `unaudited_transitions` and the interventions metric reads a deliberate verb as a human hand on the database.
  await withKernelMarker(db, async (tx) => {
    await tx
      .update(agentSessions)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(agentSessions.id, args.agentSessionId));

    await tx
      .update(agentQuestions)
      .set({
        status: 'void',
        voidReason: `stop: ${args.reason}`,
        endedBy: args.by,
        endedReason: 'stopped',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentQuestions.agentSessionId, args.agentSessionId),
          inArray(agentQuestions.status, ['open', 'answered']),
        ),
      );
  });
}

export function isTerminalSessionStatus(status: string) {
  return (terminalAgentSessionStatuses as readonly string[]).includes(status);
}
