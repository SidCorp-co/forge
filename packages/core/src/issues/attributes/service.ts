import { db } from '../../db/client.js';
import { loadIssueAttributes, type RenderedAttribute } from './read.js';
import { type AttributeWrite, writeAttributes } from './write.js';

/** One transaction: `writeAttributes` deletes a cardinality-one row before inserting, so on the raw handle a later refusal in the same batch left the old value gone and nothing in its place. */
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
