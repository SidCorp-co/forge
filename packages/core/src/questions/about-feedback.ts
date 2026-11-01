// The feedback item a question is asked about, as the ask doors check it before storing `about`, and
// the rule that a question a delivery run asks on an issue names the product item it is about
// (REQ-67 BC-5): asked and answered there, never parked on the issue alone.

import type { QuestionAbout, QuestionRefusalCode } from '@forge/contracts/questions';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { type IssueDependencyExecutor, issueDisplayIds } from '../issues/index.js';
import { refuser } from '../lib/refusal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refuse = refuser<QuestionRefusalCode>('QUESTION_REFUSED');

/**
 * The stored `about` of a question on a feedback item, or a refusal naming the id when it is not a
 * feedback item of the project; a key or any other non-uuid names none.
 */
export async function feedbackAbout(
  executor: IssueDependencyExecutor,
  projectId: string,
  feedbackId: string,
): Promise<QuestionAbout> {
  const rows = UUID.test(feedbackId)
    ? ((await executor.execute(
        sql`select 1 from feedback where id = ${feedbackId}::uuid and project_id = ${projectId}::uuid`,
      )) as unknown as unknown[])
    : [];
  if (rows.length === 0) {
    throw refuse(
      'QUESTION_ABOUT_UNKNOWN',
      `\`about.feedbackId\` is \`${feedbackId}\`, which names no feedback item of this project — name one by its id (a uuid), never its key`,
      '/about/feedbackId',
    );
  }
  return { kind: 'feedback', feedbackId };
}

/** The feedback items an issue carries: each routed to it, oldest first. */
async function carriedBy(executor: IssueDependencyExecutor, issueId: string) {
  return rowsOf<{ id: string; key: string }>(
    await executor.execute(sql`
      SELECT f.id, 'FB-' || f.fb_seq AS key
        FROM feedback_route_issues r JOIN feedback f ON f.id = r.feedback_id
       WHERE r.issue_id = ${issueId}
       ORDER BY f.fb_seq`),
  );
}

/**
 * The stored `about` an ask's `{ feedback }` names: an item of the project by its key (FB-n) or id,
 * or, with null, the one item the asking issue carries; refused by name where it names none or the
 * issue carries several.
 */
export async function feedbackAboutRequest(
  executor: IssueDependencyExecutor,
  input: { projectId: string; issueId?: string | undefined },
  ref: string | null,
): Promise<QuestionAbout> {
  if (ref === null) {
    const carried = input.issueId ? await carriedBy(executor, input.issueId) : [];
    const [only] = carried;
    if (only && carried.length === 1) return { kind: 'feedback', feedbackId: only.id };
    throw refuse(
      'QUESTION_ABOUT_NO_FEEDBACK',
      !input.issueId
        ? '`about.feedback` is null, which names the feedback item of the issue asked on, and this question is asked on no issue — name the item by its key (FB-n)'
        : carried.length === 0
          ? `\`about.feedback\` is null, which names the feedback item issue ${input.issueId} carries, and it carries none — name the item by its key (FB-n)`
          : `\`about.feedback\` is null, and issue ${input.issueId} carries ${carried.map((c) => c.key).join(', ')} — name the one it is about by its key`,
      '/about/feedback',
    );
  }
  const key = /^FB-(\d+)$/i.exec(ref);
  const [hit] = rowsOf<{ id: string }>(
    await executor.execute(
      key
        ? sql`SELECT id FROM feedback WHERE project_id = ${input.projectId} AND fb_seq = ${Number(key[1])}`
        : UUID.test(ref)
          ? sql`SELECT id FROM feedback WHERE project_id = ${input.projectId} AND id = ${ref}::uuid`
          : sql`SELECT NULL::uuid AS id WHERE false`,
    ),
  );
  if (!hit) {
    throw refuse(
      'QUESTION_ABOUT_UNKNOWN',
      `\`about.feedback\` is \`${ref}\`, which names no feedback item of this project — name one by its key (FB-n) or id`,
      '/about/feedback',
    );
  }
  return { kind: 'feedback', feedbackId: hit.id };
}

/**
 * Refuses a question a run or an agent asks, owed by a person or the master, on an issue that delivers
 * a requirement or carries a feedback item, that names no `about` (REQ-67 BC-5): delivery's question is asked and
 * answered on the product item, so it is listed there and its answer recorded there. Read after
 * `owed.ts:owedBlockerOf`, so outside strict the master's question is held to it too; a machine's
 * wait is never a business question. A wait on a merge mark or a
 * design decision is answered by that fact and names nothing, and a steward decision about the issue
 * itself carries Forge's own options: neither is refused. An issue that delivers and carries nothing
 * keeps its question.
 */
export async function refuseAboutMissing(
  executor: IssueDependencyExecutor,
  input: {
    issueId?: string | undefined;
    about?: unknown;
    blockerKind: string;
    askedByRun?: true | undefined;
    askedByAgent?: true | undefined;
    awaitsMerge?: unknown;
    awaitsDesign?: unknown;
    answer?: { shape: string; options?: readonly { fingerprint?: string | undefined }[] };
  },
): Promise<void> {
  if (!input.issueId || input.about || input.blockerKind === 'machine') return;
  // a person asking on the issue is no delivery run: the rule is for what delivery raises
  if (!input.askedByRun && !input.askedByAgent) return;
  const stewards = (input.answer?.options ?? []).some((o) => o.fingerprint?.startsWith('steward:'));
  if (input.awaitsMerge || input.awaitsDesign || stewards) return;
  const [issue] = rowsOf<{ requirement: string | null }>(
    await executor.execute(sql`
      SELECT 'REQ-' || r.req_seq AS requirement
        FROM issues i LEFT JOIN requirements r ON r.id = i.requirement_id
       WHERE i.id = ${input.issueId}`),
  );
  const carried = await carriedBy(executor, input.issueId);
  if (!issue?.requirement && carried.length === 0) return;
  const items = [
    ...(issue?.requirement ? [`delivers ${issue.requirement}`] : []),
    ...(carried.length ? [`carries ${carried.map((c) => c.key).join(', ')}`] : []),
  ].join(' and ');
  const shapes = [
    ...(issue?.requirement ? ['{"requirement":null}'] : []),
    ...(carried.length === 1 ? ['{"feedback":null}'] : []),
    ...(carried.length > 1 ? ['{"feedback":"FB-n"}'] : []),
  ].join(' or ');
  const key = (await issueDisplayIds([input.issueId], executor as Tx)).get(input.issueId);
  throw refuse(
    'QUESTION_ABOUT_REQUIRED',
    `${key ?? `issue ${input.issueId}`} ${items}: a question delivery raises is asked about that item, listed on it and answered there, never parked on the issue alone — send \`about\` ${shapes}`,
    '/about',
  );
}
