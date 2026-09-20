import { db } from '../../db/client.js';
import { loadIssueAttributes, type RenderedAttribute } from './read.js';
import { type AttributeWrite, writeAttributes } from './write.js';

/**
 * The whole batch in one transaction.
 *
 * `writeAttributes` deletes a cardinality-one key's existing row before
 * inserting the new one, so on the raw handle a later refusal in the same
 * batch — an unregistered key, a value the defs table has no row for — left
 * the old value deleted and nothing in its place. The caller was told no and
 * the issue had lost an assertion anyway (ISS-1113). One transaction makes the
 * refusal and the rows agree.
 */
export async function setIssueAttributes(
  writes: readonly AttributeWrite[],
): Promise<{ written: number; attributes: RenderedAttribute[] }> {
  const written = await db.transaction(async (tx) => writeAttributes(writes, tx));
  const issueId = writes[0]?.issueId;
  return {
    written,
    attributes: issueId ? await loadIssueAttributes(issueId) : [],
  };
}
