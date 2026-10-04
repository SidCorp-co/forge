// Every issue lives again in the memory corpus as a `memories` row (`source = 'issue'`,
// `source_ref = issues.id`), and extraction tags the facts it draws from one `metadata.issueId`.
// Recall, the alike check and knowledge search read that corpus, so an archived issue
// (`issues/archive.ts`) has to be left out here too, or its text stays reachable.
import { type SQL, sql } from 'drizzle-orm';
import { memories } from '../db/schema.js';

const archivedIssueIds = (projectId: string) =>
  sql`(SELECT ai.id::text FROM issues ai WHERE ai.project_id = ${projectId} AND ai.archived_at IS NOT NULL)`;

/**
 * A memory row that is not the text of an archived issue, nor a fact extracted from one. `NOT IN`
 * over the project's archived ids is a hashed subplan, evaluated once per query rather than once
 * per memory row.
 */
function liveIssueMemory(cols: { source: SQL; sourceRef: SQL; metadata: SQL }, projectId: string) {
  const archived = archivedIssueIds(projectId);
  return sql`((${cols.source} <> 'issue' OR ${cols.sourceRef} NOT IN ${archived}) AND coalesce(${cols.metadata}->>'issueId', '') NOT IN ${archived})`;
}

export function memoryOfLiveIssue(projectId: string): SQL {
  return liveIssueMemory(
    {
      source: sql`${memories.source}`,
      sourceRef: sql`${memories.sourceRef}`,
      metadata: sql`${memories.metadata}`,
    },
    projectId,
  );
}
