import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, labels } from '../db/schema.js';

export type IssueLabelLite = { id: string; name: string; color: string };

/**
 * ISS-633 — an issue's current labels. Used by the MCP focused single-issue
 * serializers (`serializeWithAttachments` / `serializeManifestWithAttachments`
 * in mcp/tools/forge-issues.ts) so a skill can read-then-replace `data.labels`
 * without clobbering the existing set. Kept in its own module (mirroring
 * `listIssueAttachments` in attachment-service.ts) so it can be mocked
 * independently of the generic `db.select` chain in tests.
 */
export async function listIssueLabels(issueId: string): Promise<IssueLabelLite[]> {
  return db
    .select({ id: labels.id, name: labels.name, color: labels.color })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(eq(issueLabels.issueId, issueId));
}
