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
