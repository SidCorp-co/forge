import { inArray } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { comments } from '../../db/schema.js';
import { AttributeRefusal, type AttributeWrite } from './write.js';

/**
 * Every `sourceCommentId`, checked against the issue its attribute is written
 * to, ahead of the insert: the constraint cannot separate the two wrong
 * values, because an id naming no comment breaks a foreign key other than the
 * `issue_attribute_defs` one, and one naming a comment on ANOTHER issue
 * violates nothing at all (ISS-1113).
 *
 * It reads through the caller's handle so the check and the insert see one
 * snapshot, and it is reached from `setIssueAttributes` rather than from a
 * door, so every caller of that writer inherits it (ISS-1158).
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

  // A uuid is case-insensitive and Postgres renders one in lowercase, so both
  // sides are folded: the caller's own spelling decides nothing, and an
  // uppercase id naming a real comment on this issue is accepted rather than
  // refused for the shape of its hex.
  const fold = (v: string): string => v.toLowerCase();
  const found = new Map(rows.map((r) => [fold(r.id), r.issueId]));

  const missing = wanted.filter((id) => !found.has(fold(id)));
  if (missing.length > 0) {
    throw new AttributeRefusal(
      'SOURCE_COMMENT_NOT_FOUND',
      `sourceCommentId ${missing.map((i) => `\`${i}\``).join(', ')} names no comment. It must be the id of a comment on this issue — the row exists to point back at the sentence that asserted it.`,
      { missing },
    );
  }

  const offenders = pointers.filter((p) => fold(found.get(fold(p.id)) ?? '') !== fold(p.issueId));
  if (offenders.length > 0) {
    const ids = [...new Set(offenders.map((o) => o.id))];
    throw new AttributeRefusal(
      'SOURCE_COMMENT_OFF_ISSUE',
      `sourceCommentId ${ids.map((i) => `\`${i}\``).join(', ')} names a comment on a different issue (${ids.map((i) => `\`${i}\` is on \`${found.get(fold(i))}\``).join(', ')}). The pointer must stay on the issue the attribute is written to, or no reader can follow it back.`,
      { ids, issueId: offenders[0]?.issueId },
    );
  }
}
