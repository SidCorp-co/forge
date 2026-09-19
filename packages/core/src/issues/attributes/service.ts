import { db } from '../../db/client.js';
import { loadIssueAttributes, type RenderedAttribute } from './read.js';
import { type AttributeWrite, writeAttributes } from './write.js';

export async function setIssueAttributes(
  writes: readonly AttributeWrite[],
): Promise<{ written: number; attributes: RenderedAttribute[] }> {
  const written = await writeAttributes(writes, db);
  const issueId = writes[0]?.issueId;
  return {
    written,
    attributes: issueId ? await loadIssueAttributes(issueId) : [],
  };
}
