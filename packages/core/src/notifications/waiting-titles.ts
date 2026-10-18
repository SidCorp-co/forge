import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { parkOwerNameSql, parkOwerSql } from '../projects/stuck-issue-kinds.js';

/** Who a waiting park is owed by, as one reader is told it: them, a named person, or nobody known. */
export type ParkOwedBy = { you: true } | { you: false; name: string | null };

/**
 * What a park asks for, said to one reader: "you" only where that reader owes it, and otherwise the
 * person who does by name (ISS-1229 r16, the master's ruling on criterion 98).
 */
export function waitingParkAsk(waitingKind: string | null, owedBy: ParkOwedBy): string {
  const who = owedBy.you ? null : owedBy.name;
  if (waitingKind === 'needs_decision') {
    if (owedBy.you) return 'your decision';
    return who ? `${who}'s decision` : 'a decision';
  }
  if (waitingKind === 'needs_resource') {
    if (owedBy.you) return 'something only you can supply';
    return `something only ${who ?? 'a person'} can supply`;
  }
  return owedBy.you ? 'you' : (who ?? 'a person');
}

export function waitingParkTitle(args: {
  ref: string;
  waitingKind: string | null;
  owedBy: ParkOwedBy;
  projectName: string;
}): string {
  return `${args.ref} is waiting for ${waitingParkAsk(args.waitingKind, args.owedBy)} — ${args.projectName}`;
}

/**
 * The title each waiting-park notice among `notificationIds` reads to `readerId`, built from the
 * issue as it stands; a notice of any other kind has no entry and keeps its stored title.
 */
export async function waitingTitlesFor(
  readerId: string,
  notificationIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(notificationIds)];
  if (ids.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT n.id, p.issue_prefix AS prefix, i.iss_seq AS seq, i.waiting_kind AS "waitingKind",
           p.name AS "projectName",
           ${parkOwerSql(sql`i.id`)} = ${readerId}::uuid AS "readerOwes",
           ${parkOwerNameSql(sql`i.id`)} AS "owedBy"
      FROM notifications n
      JOIN issues i ON i.id = n.issue_id
      JOIN projects p ON p.id = i.project_id
     WHERE n.id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND n.type = 'issue_stranded'
       AND n.resolution_key LIKE '%:stranded'
  `)) as unknown as Array<{
    id: string;
    prefix: string | null;
    seq: number | null;
    waitingKind: string | null;
    projectName: string;
    readerOwes: boolean | null;
    owedBy: string | null;
  }>;
  return new Map(
    rows.map((r) => [
      r.id,
      waitingParkTitle({
        ref: r.seq !== null ? formatIssueRef(r.prefix, r.seq) : 'An issue',
        waitingKind: r.waitingKind,
        owedBy: r.readerOwes ? { you: true } : { you: false, name: r.owedBy },
        projectName: r.projectName,
      }),
    ]),
  );
}
