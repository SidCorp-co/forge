// A chat turn that holds its session but never reached its box (ISS-977): it ends failed, never
// left running, whether the box's socket dropped before the frame or its token could not be minted.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { noClaudeClient } from './chat-device.js';
import { transitionSessions } from './session-transition.js';

/** The box's socket dropped between the check and the frame: the turn is failed, never left running. */
export async function failUndelivered(sessionId: string): Promise<never> {
  await failUnsent(sessionId, 'no_client_ack');
  throw noClaudeClient('session');
}

/** A turn that holds the session but was never sent to its box ends failed. */
async function failUnsent(
  sessionId: string,
  reason: 'no_client_ack' | 'credential_mint_failed',
): Promise<void> {
  await transitionSessions(db, {
    to: 'failed',
    set: { failureReason: reason, updatedAt: new Date() },
    where: eq(agentSessions.id, sessionId),
    reason,
    actor: { type: 'system' },
    source: 'chat-turn',
  });
}

/**
 * The turn's token: as handed, or minted now that the turn holds the session, so a turn refused
 * beside a running one never revokes the token that turn runs under. A mint that throws fails the
 * turn it was for.
 */
export async function credentialOf(
  credential: string | (() => Promise<string>) | undefined,
  sessionId: string,
): Promise<string | undefined> {
  if (typeof credential !== 'function') return credential;
  try {
    return await credential();
  } catch (err) {
    await failUnsent(sessionId, 'credential_mint_failed');
    throw err;
  }
}
