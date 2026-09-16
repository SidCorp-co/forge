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
