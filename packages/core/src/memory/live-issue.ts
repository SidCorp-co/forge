// Every issue lives again in the memory corpus as a `memories` row (`source = 'issue'`,
// `source_ref = issues.id`), and extraction tags the facts it draws from one `metadata.issueId`.
// Recall, the alike check and knowledge search read that corpus, so an archived issue
// (`issues/archive.ts`) has to be left out here too, or its text stays reachable.
import { type SQL, sql } from 'drizzle-orm';
import { memories } from '../db/schema.js';

/**
 * A memory row that is not the text of an archived issue, nor a fact extracted from one. `NOT IN`
 * over the project's archived ids is a hashed subplan, evaluated once per query rather than once
 * per memory row.
 */
export function memoryOfLiveIssue(projectId: string): SQL {
  const archived = sql`(SELECT ai.id::text FROM issues ai WHERE ai.project_id = ${projectId} AND ai.archived_at IS NOT NULL)`;
  return sql`((${memories.source} <> 'issue' OR ${memories.sourceRef} NOT IN ${archived}) AND coalesce(${memories.metadata}->>'issueId', '') NOT IN ${archived})`;
}
