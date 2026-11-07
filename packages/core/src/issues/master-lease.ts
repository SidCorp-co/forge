// Whether a lease on an issue is the project's master's own, said by one rule for the issue rows and
// the live bar (ISS-1109, UI-E residuals 1 and 2). Every pane on a box leases under one holder id
// (`forge-master-sid-xeon-1`, ISS-1104), and a pane may write that lease through another device's
// token, so the device that wrote one lease does not say whose it is. The holder does: a holder is
// the master's where some lease of the project was written under it from the box a live master
// session of the project is on.

import { MASTER_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { type SQL, sql } from 'drizzle-orm';
import { terminalAgentSessionStatuses } from '../db/session-vocabulary.js';

const ENDED = sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * True where the lease on `work` (an `issue_work_state` row of `issue`) is held under a holder the
 * project's master leases under; false for no lease, and where no live master is placed.
 */
export function leaseByMasterSql(issue: SQL, work: SQL): SQL {
  return sql`(${work}.lease_holder IS NOT NULL AND EXISTS (
    SELECT 1
      FROM issue_work_state mw
      JOIN issues mi ON mi.id = mw.issue_id
      JOIN agent_sessions ms ON ms.device_id = mw.lease_device_id
     WHERE mw.lease_holder = ${work}.lease_holder
       AND mi.project_id = ${issue}.project_id
       AND ms.project_id = ${issue}.project_id
       AND ms.kind = ${MASTER_SESSION_KIND}
       AND ms.status NOT IN (${ENDED})))`;
}
