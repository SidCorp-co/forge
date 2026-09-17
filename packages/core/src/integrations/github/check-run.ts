/**
 * Writing `forge/issue-contract` onto one head. ISS-1072.
 *
 * ## Why this is find-then-write rather than an upsert
 *
 * The Checks API has no upsert. `POST /check-runs` with a name already on that
 * head makes a SECOND run under the same name; only `PATCH /check-runs/:id`
 * replaces one. So a publish is a lookup and then one of two writes, and the
 * lookup filters GitHub's runs on the name and on this App.
 *
 * ## Why the whole of it is under a lock, and why the ANSWER is inside too
 *
 * Two publishes for one head are ordinary, not exotic: a `pull_request`
 * delivery and a record write land within milliseconds of each other all day.
 * Without serialisation both lookups find no run and both create one, and the
 * pull request carries two contradictory check runs with nobody able to say
 * which is current.
 *
 * The answer is computed INSIDE the lock for the second half of the same
 * problem. Serialising only the write still lets a publish that computed its
 * answer first, and got to the write second, replace a newer answer with an
 * older one — a check that reads current and is not, which is the exact failure
 * the projection this rides on exists to remove. Computing inside means the
 * last writer in is also the one that looked last.
 *
 * The lock is a Postgres advisory lock rather than a row lock, because there is
 * no row to lock: the thing being serialised lives on GitHub. It is taken
 * transaction-scoped so it cannot leak onto a pooled connection, and the
 * transaction does no other database work — it holds a connection across an
 * HTTP call, which is why every request under it carries an 8s timeout.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { CHECK_RUN_NAME, checkRunBody, type CheckConclusion } from './check-run-body.js';
import type { GitHubRepoClient } from './client.js';
import { type ContractAnswer, contractAnswerForIssue } from './contract-answer.js';

// cm:guard the namespace half of the advisory key, and it is a CONSTANT so that two different features hashing the same string never collide on one lock. `hashtext` is 32-bit and collides on its own; a shared namespace would make two unrelated subsystems wait on each other for no reason anybody could find.
const ADVISORY_NAMESPACE = 1072;

export interface PublishedCheck {
  outcome: 'created' | 'updated';
  checkRunId: number;
  conclusion: CheckConclusion;
  answerKind: ContractAnswer['kind'];
}

interface CheckRunListing {
  check_runs?: Array<{ id?: number }>;
}

const repoPath = (client: GitHubRepoClient) =>
  `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}`;

/** The id of the run this App already published on that head, or null. */
async function existingRunId(client: GitHubRepoClient, headSha: string): Promise<number | null> {
  // cm:guard filtered by check_name AND by this App's own runs — `?check_name=` alone would match a run some other App published under the same name, and PATCHing another App's check run is refused by GitHub with a 403 that reads exactly like a missing permission.
  const listing = await client.publish<CheckRunListing>({
    op: 'lookup',
    method: 'GET',
    path:
      `${repoPath(client)}/commits/${encodeURIComponent(headSha)}/check-runs` +
      `?check_name=${encodeURIComponent(CHECK_RUN_NAME)}&filter=latest&app_id=${client.appId}`,
  });
  const first = listing.check_runs?.[0]?.id;
  return typeof first === 'number' ? first : null;
}

/**
 * Compute the contract's answer for this issue and put it on this head, as one
 * serialised operation.
 *
 * Throws `GitHubPublishError`; `check-refusal.ts` is what turns one into the
 * sentence an operator reads.
 */
export async function publishContractCheck(
  client: GitHubRepoClient,
  args: { issueId: string; headSha: string },
): Promise<PublishedCheck> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ADVISORY_NAMESPACE}, hashtext(${`${client.bindingId}:${args.headSha}`}))`,
    );

    const answer = await contractAnswerForIssue(args.issueId);
    const body = checkRunBody(answer);
    const output = { title: body.title, summary: body.summary, text: body.text };

    const existing = await existingRunId(client, args.headSha);
    if (existing !== null) {
      await client.publish<{ id?: number }>({
        op: 'update',
        method: 'PATCH',
        path: `${repoPath(client)}/check-runs/${existing}`,
        body: {
          status: 'completed',
          conclusion: body.conclusion,
          completed_at: new Date().toISOString(),
          output,
        },
      });
      return {
        outcome: 'updated' as const,
        checkRunId: existing,
        conclusion: body.conclusion,
        answerKind: answer.kind,
      };
    }

    const created = await client.publish<{ id?: number }>({
      op: 'create',
      method: 'POST',
      path: `${repoPath(client)}/check-runs`,
      body: {
        name: CHECK_RUN_NAME,
        head_sha: args.headSha,
        status: 'completed',
        conclusion: body.conclusion,
        completed_at: new Date().toISOString(),
        external_id: args.issueId,
        output,
      },
    });
    return {
      outcome: 'created' as const,
      checkRunId: created.id ?? 0,
      conclusion: body.conclusion,
      answerKind: answer.kind,
    };
  });
}
