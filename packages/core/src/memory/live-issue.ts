// Every issue lives again in the memory corpus as a `memories` row (`source = 'issue'`,
// `source_ref = issues.id`), and extraction tags the facts it draws from one `metadata.issueId`.
// Recall, the alike check and knowledge search read that corpus, so an archived issue
// (`issues/archive.ts`) has to be left out here too, or its text stays reachable.
import { type SQL, sql } from 'drizzle-orm';
import { memories } from '../db/schema.js';
import { memoryIssueReads } from './ports.js';

/** A memory row that is not the text of an archived issue, nor a fact extracted from one. */
export function memoryOfLiveIssue(projectId: string): SQL {
  const archived = memoryIssueReads().archivedIssueIds(projectId);
  return sql`((${memories.source} <> 'issue' OR ${memories.sourceRef} NOT IN ${archived}) AND coalesce(${memories.metadata}->>'issueId', '') NOT IN ${archived})`;
}
