/**
 * Runner-health write-back for the chat/schedule terminal report, lifted out
 * of `PATCH /api/agent-sessions/:id` so that handler stays inside its frozen
 * size budget (`.forge/size-baseline.json`). Behaviour is unchanged — the
 * guards below travelled with the code they constrain.
 *
 * A device that only ever serves chat turns produces no jobs, so the job-lane
 * limit detector never sees it; without this write-back its `runners` row
 * would keep a stale limit and the dispatch health gate would keep excluding
 * (or keep trusting) it on evidence from days ago.
 */

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
// cm:guard gate the STAMP on the DEVICE principal — a user/member PATCH can carry an arbitrary crafted `messages` array (patchSchema.messages is unvalidated), so classifying non-device-authored PATCHes would let a project member mis-stamp a healthy runner and DoS pipeline dispatch (dispatch-gates.ts hard-excludes a rate-limited runner)
// cm:guard the stamp reads the REPORTED status and the clear reads the PERSISTED one, and the asymmetry is deliberate: a core-side rewrite of `completed` into `failed` (skill_not_synced, audit_ran_blind) is core's own verdict about the AGENT, not evidence the runner is rate-limited — clearing on the rewritten outcome would hide the failure from the health gate, stamping on it would blame the box for the model
export async function syncRunnerHealthFromChatTerminal(
  input: ChatRunnerHealthInput,
): Promise<void> {
  if (!input.deviceId) return;

  if (input.principal === 'device' && input.reportedStatus === 'failed' && !input.isUserCancelled) {
    try {
      // cm:guard classify only runner-authored text — the transcript's first message is buildAgentChatPrompt's output (the user's own question), so an unfiltered blob lets user content trip isRateLimitError/isAuthError and mis-limit a healthy runner
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

  // cm:why symmetric to the stamp — without it a runner stamped 'auth' once stays excluded forever on a project that only ever runs chat, since nothing else on that lane ever clears the row
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
