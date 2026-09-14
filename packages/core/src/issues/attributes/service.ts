import { db } from '../../db/client.js';
import { loadIssueAttributes, type RenderedAttribute } from './read.js';
import { type AttributeWrite, writeAttributes } from './write.js';

// cm:why Both transports enter here rather than holding `db` themselves — a query that lives in a tool is a second data plane the REST side cannot reach, and the two drift in silence (ISS-889, gated by mcp/tools/no-transport-db.test.ts).
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
