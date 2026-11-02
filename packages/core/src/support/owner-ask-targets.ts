// What a channel agent's question to the owner may name (ISS-874): an issue, on which the owner's
// answer is written, and a master's open Forge question, which the answer settles. Either may be any
// project's the agent follows, never one outside its set.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { agentQuestions } from '../db/schema-questions.js';
import { keyOf } from './ops-reads.js';
import type { ScopedProject } from './ops-scope.js';

/** Why a Forge question cannot take the owner's answer through this channel, or null. */
export async function questionRefusal(
  projectIds: readonly string[],
  questionId: string,
): Promise<string | null> {
  const [q] = await db
    .select({
      projectId: agentQuestions.projectId,
      status: agentQuestions.status,
      batchId: agentQuestions.batchId,
    })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  if (!q || !projectIds.includes(q.projectId))
    return `${questionId} names no question of the projects this agent follows`;
  if (q.status !== 'open')
    return `question ${questionId} is ${q.status}, and only an open one takes an answer`;
  if (q.batchId)
    return `question ${questionId} is an item of a questionnaire, answered with its batch`;
  return null;
}

/**
 * The issue a key such as `ISS-12` names among the projects the agent follows: the home project's by
 * its number, as before ISS-874, else a followed project's whose prefix the key carries; null where
 * none holds it.
 */
export async function issueInReach(
  reach: readonly ScopedProject[],
  key: string,
): Promise<{ id: string } | null> {
  const [home, ...followed] = reach;
  const prefix = `${key.split('-')[0]?.toUpperCase() ?? ''}-`;
  const candidates = [
    ...(home ? [home] : []),
    ...followed.filter((p) => keyOf(p, 0).toUpperCase().startsWith(prefix)),
  ];
  for (const p of candidates) {
    const found = await issueOfKey(p.id, key);
    if (found) return found;
  }
  return null;
}

/** The issue of the project a key such as `ISS-12` names, or null. */
async function issueOfKey(projectId: string, key: string): Promise<{ id: string } | null> {
  const seq = Number(key.replace(/^\D+/, ''));
  if (!Number.isSafeInteger(seq)) return null;
  const [row] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, seq)))
    .limit(1);
  return row ?? null;
}
