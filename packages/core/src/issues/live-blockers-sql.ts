/** The live-blocker predicate of `devices/admissible.ts`, as SQL; `backlog-rank-e2e.test.ts` holds the two to one answer (ISS-1336). */

import { type SQL, sql } from 'drizzle-orm';
import { DISPATCH_GATING_KIND, releasingStatusesFor } from './dependency-effects.js';

const statusList = (hold: 'settled' | 'shipped'): SQL =>
  sql.join(
    releasingStatusesFor(hold).map((status) => sql`${status}`),
    sql`, `,
  );

/** Edge `d` and blocker `b` rows that hold a dependent back now, from `FROM` on; `dependentTest` compares `d.to_issue_id`. */
export function liveBlockerRowsSql(projectId: string, dependentTest: SQL): SQL {
  return sql`
    FROM issue_dependencies d
    JOIN issues b ON b.id = d.from_issue_id
    WHERE d.project_id = ${projectId}::uuid
      AND d.to_issue_id ${dependentTest}
      AND d.kind = ${DISPATCH_GATING_KIND}
      AND (d.valid_until IS NULL OR d.valid_until > now())
      AND (
        (d.holds_until = 'settled' AND b.status NOT IN (${statusList('settled')}))
        OR (d.holds_until = 'shipped' AND b.status NOT IN (${statusList('shipped')}))
      )`;
}

export const hasLiveBlockerSql = (projectId: string, issueColumn: SQL): SQL =>
  sql`EXISTS (SELECT 1 ${liveBlockerRowsSql(projectId, sql`= ${issueColumn}`)})`;
