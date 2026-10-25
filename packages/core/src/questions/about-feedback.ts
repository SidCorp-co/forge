// The feedback item a question is asked about, as the ask door checks it before storing `about`.

import type { QuestionAbout, QuestionRefusalCode } from '@forge/contracts/questions';
import { sql } from 'drizzle-orm';
import type { IssueDependencyExecutor } from '../issues/index.js';
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
