// What a finish leaves on a roster issue it could not close (ISS-811): the release verified
// production serving and `closed` was refused, so cutting the issue into another release would run
// the same finish into the same refusal (agenfold ISS-11: seven releases, 0.8.0 to 0.14.0, each
// recorded it under `failed`). `RELEASE_UNCLOSED_QUESTION` is a refusal that clears itself the
// moment no question is open on the issue; `RELEASE_UNCLOSED_REFUSED` is any other refusal, cleared
// by a person. Both hold the issue out of every unattended cut (`hold.ts:heldFromUnattendedCut`).

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentQuestions } from '../db/schema-questions.js';
import { releaseHolds } from '../db/schema-release-ledger.js';
import {
  clearReleaseHolds,
  RELEASE_UNCLOSED_QUESTION,
  RELEASE_UNCLOSED_REFUSED,
  type ReleaseHold,
} from './hold.js';

/**
 * Held because the release's finish could not close the issue. A person's act ends it: their own
 * cut claims the row, or any move takes it off the gate. An open-question refusal ends when the
 * question does (`clearAnsweredQuestionHolds`).
 */
export function unclosedHold(args: {
  version: string | null;
  refusal: string;
  openQuestionIds: readonly string[];
}): ReleaseHold {
  const release = args.version ? `Release ${args.version}` : 'The release';
  const asked = args.openQuestionIds.length > 0;
  const waitingFor = asked
    ? `the open question ${args.openQuestionIds.join(', ')} to be answered or voided`
    : 'the refusal named here to be cleared';
  return {
    code: asked ? RELEASE_UNCLOSED_QUESTION : RELEASE_UNCLOSED_REFUSED,
    reason:
      `${release} could not close this issue, so it does not carry it: ${args.refusal} No ` +
      `automatic release or schedule cuts it again while this stands. ${
        asked
          ? 'It ends when no question is open on the issue'
          : 'A person clears the refusal, then cuts the release by hand'
      }, or moves the issue out of \`awaiting_release\` if it is not to ship.`,
    owes: 'human',
    waitingFor,
  };
}

/** The questions open on each of these issues, oldest first: what a close was refused for. */
export async function openQuestionIdsOf(
  issueIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (issueIds.length === 0) return out;
  const rows = await db
    .select({ id: agentQuestions.id, issueId: agentQuestions.issueId })
    .from(agentQuestions)
    .where(and(inArray(agentQuestions.issueId, [...issueIds]), eq(agentQuestions.status, 'open')))
    .orderBy(agentQuestions.createdAt, agentQuestions.id);
  for (const r of rows) {
    if (r.issueId) out.set(r.issueId, [...(out.get(r.issueId) ?? []), r.id]);
  }
  return out;
}

/**
 * Take off the open-question holds whose question is gone: the refusal that held the issue no
 * longer stands, so the next cut weighs it again. Answers the rows it released.
 */
export async function clearAnsweredQuestionHolds(
  issueIds: readonly string[],
  now: Date = new Date(),
): Promise<string[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .select({ issueId: releaseHolds.issueId })
    .from(releaseHolds)
    .where(
      and(
        inArray(releaseHolds.issueId, [...issueIds]),
        eq(releaseHolds.code, RELEASE_UNCLOSED_QUESTION),
        isNull(releaseHolds.clearedAt),
        sql`not exists (select 1 from agent_questions q
          where q.issue_id = ${releaseHolds.issueId} and q.status = 'open')`,
      ),
    );
  const ids = rows.map((r) => r.issueId);
  await clearReleaseHolds(ids, now);
  return ids;
}
