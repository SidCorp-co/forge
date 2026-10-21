import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';
import { recordCorrection } from '../lessons/index.js';
import { type Row, type SuggestionActor, targetOfRow } from './read.js';
import { targetsOf } from './waiting-read.js';

/**
 * A rejection said with a reason is a correction a lesson learns from (REQ-50 BC-1), kept in the
 * rejection's own transaction: the suggestion, keyed by what it is on, and that target's area.
 */
export async function keepRejectionAsCorrection(
  tx: Tx,
  row: Row,
  actor: SuggestionActor,
  reason: string | null,
): Promise<void> {
  if (!reason) return;
  const target = targetOfRow(row);
  const named = (await targetsOf(row.projectId, [row])).get(target.id);
  const [area] =
    target.type === 'requirement'
      ? await tx
          .select({ id: requirements.areaId })
          .from(requirements)
          .where(and(eq(requirements.projectId, row.projectId), eq(requirements.id, target.id)))
      : [];
  await recordCorrection(tx, {
    projectId: row.projectId,
    source: 'suggestion_rejected',
    sourceRef: row.id,
    item: {
      kind: 'suggestion',
      id: row.id,
      key: named?.key ?? target.type,
      title: `${row.kind} suggestion${named ? `: ${named.title}` : ''}`,
    },
    areaId: area?.id ?? null,
    reason,
    by: { userId: actor.userId, agency: actor.agency },
  });
}
