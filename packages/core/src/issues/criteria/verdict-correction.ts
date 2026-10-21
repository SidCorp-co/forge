import { eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { requirements } from '../../db/schema-requirements.js';
import { issueDisplayIds } from '../display-ids.js';
import { keepCorrection } from '../ports.js';

/**
 * A failing verdict said with a reason is a correction a lesson learns from (REQ-50 BC-1), kept in
 * the verdict's own transaction: the issue, its criterion, and the area of the requirement it carries.
 */
export async function keepFailAsCorrection(
  tx: Tx,
  input: {
    issue: { id: string; projectId: string };
    verdictId: string;
    criterion: number;
    verdict: string;
    reason: string | null;
    author: { userId: string | null; agency: 'human' | 'agent' };
  },
): Promise<void> {
  if (input.verdict !== 'fail' || !input.reason) return;
  const [row] = await tx
    .select({ title: issues.title, areaId: requirements.areaId })
    .from(issues)
    .leftJoin(requirements, eq(requirements.id, issues.requirementId))
    .where(eq(issues.id, input.issue.id));
  const key = (await issueDisplayIds([input.issue.id], tx)).get(input.issue.id) ?? input.issue.id;
  await keepCorrection(tx, {
    projectId: input.issue.projectId,
    source: 'verdict_failed',
    sourceRef: input.verdictId,
    item: {
      kind: 'issue',
      id: input.issue.id,
      key: `${key} #${input.criterion}`,
      title: row?.title ?? null,
    },
    areaId: row?.areaId ?? null,
    reason: input.reason,
    by: input.author,
  });
}
