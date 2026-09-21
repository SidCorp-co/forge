import { inArray } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { comments } from '../../db/schema.js';
import { AttributeRefusal, type AttributeWrite } from './write.js';

const caseFoldedUuid = (v: string): string => v.toLowerCase();

/**
 * Every `sourceCommentId`, checked against the issue it is written to: the
 * constraint separates neither wrong value (ISS-1113). Raised from the writer
 * rather than a door, so a caller reaching it inherits the refusal (ISS-1158).
 */
export async function assertSourceCommentsOnIssue(
  writes: readonly AttributeWrite[],
  tx: Tx,
): Promise<void> {
  const pointers = writes.flatMap((w) =>
    w.sourceCommentId ? [{ id: w.sourceCommentId, issueId: w.issueId }] : [],
  );
  if (pointers.length === 0) return;

  const wanted = [...new Set(pointers.map((p) => p.id))];
  const rows = await tx
    .select({ id: comments.id, issueId: comments.issueId })
    .from(comments)
    .where(inArray(comments.id, wanted));
  const found = new Map(rows.map((r) => [caseFoldedUuid(r.id), r.issueId]));

  const missing = wanted.filter((id) => !found.has(caseFoldedUuid(id)));
  if (missing.length > 0) {
    throw new AttributeRefusal(
      'SOURCE_COMMENT_NOT_FOUND',
      `sourceCommentId ${missing.map((i) => `\`${i}\``).join(', ')} names no comment. It must be the id of a comment on this issue — the row exists to point back at the sentence that asserted it.`,
      { missing },
    );
  }

  const offenders = pointers.filter(
    (p) =>
      caseFoldedUuid(found.get(caseFoldedUuid(p.id)) ?? '') !== caseFoldedUuid(p.issueId),
  );
  if (offenders.length > 0) {
    const ids = [...new Set(offenders.map((o) => o.id))];
    throw new AttributeRefusal(
      'SOURCE_COMMENT_OFF_ISSUE',
      `sourceCommentId ${ids.map((i) => `\`${i}\``).join(', ')} names a comment on a different issue (${ids.map((i) => `\`${i}\` is on \`${found.get(caseFoldedUuid(i))}\``).join(', ')}). The pointer must stay on the issue the attribute is written to, or no reader can follow it back.`,
      { ids, issueId: offenders[0]?.issueId },
    );
  }
}
