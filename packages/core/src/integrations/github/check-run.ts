import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { CHECK_RUN_NAME, type CheckConclusion, checkRunBody } from './check-run-body.js';
import type { GitHubRepoClient } from './client.js';
import { type ContractAnswer, contractAnswerForIssue } from './contract-answer.js';

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

    const answer = await contractAnswerForIssue(args.issueId, tx);
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
