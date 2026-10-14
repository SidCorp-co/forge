/** The one writer. Every refusal is raised here or below; a door renders it (ISS-1158). */

import { db } from '../../db/client.js';
import { loadIssueAttributes, type RenderedAttribute } from './read.js';
import { assertSourceCommentsOnIssue } from './source-comment.js';
import { type AttributeWrite, writeAttributes } from './write.js';

/** One transaction, so a refusal partway through a batch leaves every earlier write of that batch unwritten. */
export async function setIssueAttributes(
  writes: readonly AttributeWrite[],
): Promise<{ written: number; attributes: RenderedAttribute[] }> {
  const written = await db.transaction(async (tx) => {
    await assertSourceCommentsOnIssue(writes, tx);
    return writeAttributes(writes, tx);
  });
  const issueId = writes[0]?.issueId;
  return {
    written,
    attributes: issueId ? await loadIssueAttributes(issueId) : [],
  };
}
