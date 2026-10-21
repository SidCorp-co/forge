/**
 * Whether each record a steward note cites exists in the project (the note vet's step 3): a key
 * (REQ-4, FB-9, ISS-12, a version) or an id, read per kind in one statement each.
 */

import type { StewardCite, StewardCiteKind } from '@forge/contracts/steward';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const seqOf = (ref: string) => /-(\d{1,9})$/.exec(ref)?.[1] ?? (/^\d{1,9}$/.test(ref) ? ref : null);

/** The statement that answers whether `ref` names a record of `kind` in the project. */
function existsSql(projectId: string, kind: StewardCiteKind, ref: string): SQL | null {
  const id = UUID.test(ref) ? ref : null;
  const seq = seqOf(ref);
  const byIdOrSeq = (table: SQL, seqCol: SQL) =>
    id
      ? sql`SELECT 1 FROM ${table} WHERE project_id = ${projectId} AND id = ${id}::uuid`
      : seq
        ? sql`SELECT 1 FROM ${table} WHERE project_id = ${projectId} AND ${seqCol} = ${Number(seq)}`
        : null;
  switch (kind) {
    case 'requirement':
      return byIdOrSeq(sql`requirements`, sql`req_seq`);
    case 'feedback':
      return byIdOrSeq(sql`feedback`, sql`fb_seq`);
    case 'issue':
      return byIdOrSeq(sql`issues`, sql`iss_seq`);
    case 'release':
      return id
        ? sql`SELECT 1 FROM pipeline_runs WHERE project_id = ${projectId} AND id = ${id}::uuid`
        : sql`SELECT 1 FROM pipeline_runs WHERE project_id = ${projectId} AND release_version = ${ref}`;
    case 'run':
      return id
        ? sql`SELECT 1 FROM pipeline_runs WHERE project_id = ${projectId} AND id = ${id}::uuid`
        : null;
    case 'suggestion':
      return id
        ? sql`SELECT 1 FROM suggestions WHERE project_id = ${projectId} AND id = ${id}::uuid`
        : null;
    case 'question':
      return id
        ? sql`SELECT 1 FROM agent_questions WHERE project_id = ${projectId} AND id = ${id}::uuid`
        : null;
    case 'verdict':
      return id
        ? sql`SELECT 1 FROM criterion_verdicts v JOIN issues i ON i.id = v.issue_id
               WHERE i.project_id = ${projectId} AND v.id = ${id}::uuid`
        : null;
    case 'comment':
      return id
        ? sql`SELECT 1 FROM comments c JOIN issues i ON i.id = c.issue_id
               WHERE i.project_id = ${projectId} AND c.id = ${id}::uuid`
        : null;
  }
}

/** The cites no record of the project answers, in the order given. */
export async function unknownCitesIn(
  projectId: string,
  cites: readonly StewardCite[],
): Promise<StewardCite[]> {
  const found = await Promise.all(
    cites.map(async (c) => {
      const q = existsSql(projectId, c.kind, c.ref.trim());
      if (!q) return false;
      return (
        rowsOf<{ found: boolean }>(await db.execute(sql`SELECT EXISTS (${q}) AS found`))[0]
          ?.found === true
      );
    }),
  );
  return cites.filter((_, i) => !found[i]);
}
