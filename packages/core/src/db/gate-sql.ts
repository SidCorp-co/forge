// A gate's enforcement as SQL (REQ-76), for the scans that read many projects in one statement (the
// strand sweep, the queued-job reasons) and so cannot ask `@forge/contracts/gate-profiles` per row.
// Only for a gate no other switch decides: its mode is the project's override, else its profile's
// default, exactly as `resolveGate` reads it; a keyed gate is refused here by name.

import { type GateId, gateEntry } from '@forge/contracts/gate-profiles';
import { type SQL, sql } from 'drizzle-orm';

/** True where gate `id` is enforced on the project `projectId` names. */
export function gateEnforcedSql(projectId: SQL, id: GateId): SQL {
  const { defaults } = gateEntry(id);
  const { strict, standard, yolo } = defaults;
  if (typeof strict !== 'string' || typeof standard !== 'string' || typeof yolo !== 'string') {
    throw new Error(
      `gate-sql: gate \`${id}\` reads its own switch under some profile; resolve it in code`,
    );
  }
  return sql`(coalesce(
    (SELECT d.document -> 'gates' -> 'overrides' ->> ${id} FROM project_config_documents d WHERE d.project_id = ${projectId}),
    CASE coalesce((SELECT d.document -> 'gates' ->> 'profile' FROM project_config_documents d WHERE d.project_id = ${projectId}), 'standard')
      WHEN 'strict' THEN ${strict} WHEN 'yolo' THEN ${yolo} ELSE ${standard} END
  ) = 'enforce')`;
}
