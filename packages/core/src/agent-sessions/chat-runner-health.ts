import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type AgentSessionStatus, runners } from '../db/schema.js';
import { logger } from '../logger.js';
import { clearRunnerLimit, stampRunnerLimit } from '../runners/apply-runner-limit.js';
import { detectRunnerLimit } from '../runners/limit-detect.js';
import { clearRunnerQuarantine } from '../runners/quarantine.js';
import { extractSessionFailureText } from './session-failure.js';

async function findRunnerId(projectId: string, deviceId: string): Promise<string | null> {
  const [runner] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.projectId, projectId), eq(runners.deviceId, deviceId)))
    .limit(1);
  return runner?.id ?? null;
}

export interface ChatRunnerHealthInput {
  sessionId: string;
  projectId: string;
  deviceId: string | null;
  /** Hono principal on the PATCH. */
  principal: string | undefined;
  /** The status the runner REPORTED, before any core-side rewrite. */
  reportedStatus: AgentSessionStatus | undefined;
  /** The status actually persisted, after every core-side rewrite. */
  persistedStatus: AgentSessionStatus;
  isUserCancelled: boolean;
  messages: unknown;
}

/**
 * Stamp or clear the executing runner's limit/quarantine from one chat-lane
 * terminal report. Never throws — a health write must not fail the PATCH.
 */
export async function syncRunnerHealthFromChatTerminal(
  input: ChatRunnerHealthInput,
): Promise<void> {
  if (!input.deviceId) return;

  if (input.principal === 'device' && input.reportedStatus === 'failed' && !input.isUserCancelled) {
    try {
      const text = extractSessionFailureText(input.messages, null, { excludeRoles: ['user'] });
      const limit = detectRunnerLimit(text, null);
      if (limit) {
        const runnerId = await findRunnerId(input.projectId, input.deviceId);
        if (runnerId) await stampRunnerLimit(runnerId, input.projectId, limit);
      }
    } catch (err) {
      logger.warn(
        { err, sessionId: input.sessionId, deviceId: input.deviceId },
        'agent-sessions: stampRunnerLimit from chat limit-detect failed, continuing',
      );
    }
  }

  if (input.persistedStatus === 'completed') {
    try {
      const runnerId = await findRunnerId(input.projectId, input.deviceId);
      if (runnerId) {
        await clearRunnerLimit(runnerId, input.projectId);
        await clearRunnerQuarantine(runnerId, input.projectId);
      }
    } catch (err) {
      logger.warn(
        { err, sessionId: input.sessionId, deviceId: input.deviceId },
        'agent-sessions: clearRunnerLimit on chat completion failed, continuing',
      );
    }
  }
}
