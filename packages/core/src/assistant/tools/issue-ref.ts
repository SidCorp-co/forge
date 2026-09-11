/** Lets the chat model address an issue by the `ISS-<n>` id `forge_issues` prints beside the UUID — measured 2026-09-04 on two models, both failed `get` for ISS-3 because `documentId` is `z.uuid()`; rewritten inside the bound project before the handler parses. */

import { and, eq } from 'drizzle-orm';
import type { db as defaultDb } from '../../db/client.js';
import { issues } from '../../db/schema.js';

const DISPLAY_ID = /^\s*ISS-(\d+)\s*$/i;

export type IssueLookupDb = Pick<typeof defaultDb, 'select'>;

export async function resolveIssueDisplayId(
  dbi: IssueLookupDb,
  projectId: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const raw = args.documentId;
  if (typeof raw !== 'string') return null;
  const hit = DISPLAY_ID.exec(raw);
  if (!hit) return null;
  const [row] = await dbi
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, Number(hit[1]))))
    .limit(1);
  if (!row) return `no issue ${raw.trim().toUpperCase()} in this project`;
  args.documentId = row.id;
  return null;
}
