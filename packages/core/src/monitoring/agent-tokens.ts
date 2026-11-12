/**
 * A project's monitoring agent token (ISS-1225): 256 random bits shown once and kept as their
 * SHA-256, as a feedback server key is (`feedback/server-key-rules.ts`). One per project; minting a
 * new one replaces the old, which admits nothing from then on.
 */

import { randomBytes } from 'node:crypto';
import {
  MONITORING_AGENT_TOKEN_PATTERN,
  MONITORING_AGENT_TOKEN_PREFIX,
  type MonitoringAgentTokenResponse,
} from '@forge/contracts/monitoring';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { monitoringAgentTokens } from '../db/schema-monitoring.js';
import { digestToken } from '../lib/token-digest.js';
import { listProjectHeads } from '../projects/index.js';

const SHOWN_CHARS = 12;

export async function mintAgentToken(input: {
  projectId: string;
  mintedBy: string;
}): Promise<MonitoringAgentTokenResponse> {
  const token = `${MONITORING_AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const values = {
    tokenHash: digestToken(token),
    prefix: token.slice(0, SHOWN_CHARS),
    createdBy: input.mintedBy,
    createdAt: new Date(),
  };
  await db
    .insert(monitoringAgentTokens)
    .values({ projectId: input.projectId, ...values })
    .onConflictDoUpdate({ target: monitoringAgentTokens.projectId, set: values });
  return { token, prefix: values.prefix, createdAt: values.createdAt.toISOString() };
}

/** The project a presented agent token admits writes for, with its slug; null where it names none. */
export async function projectOfAgentToken(
  token: string,
): Promise<{ projectId: string; slug: string } | null> {
  if (!MONITORING_AGENT_TOKEN_PATTERN.test(token)) return null;
  const [row] = await db
    .select({ projectId: monitoringAgentTokens.projectId })
    .from(monitoringAgentTokens)
    .where(eq(monitoringAgentTokens.tokenHash, digestToken(token)))
    .limit(1);
  if (!row) return null;
  const [head] = await listProjectHeads([row.projectId]);
  return head ? { projectId: head.id, slug: head.slug } : null;
}

/** The project's token as a listing shows it: never the secret. */
export async function agentTokenOf(
  projectId: string,
): Promise<{ prefix: string; createdAt: string } | null> {
  const [row] = await db
    .select({ prefix: monitoringAgentTokens.prefix, createdAt: monitoringAgentTokens.createdAt })
    .from(monitoringAgentTokens)
    .where(eq(monitoringAgentTokens.projectId, projectId))
    .limit(1);
  return row ? { prefix: row.prefix, createdAt: row.createdAt.toISOString() } : null;
}
