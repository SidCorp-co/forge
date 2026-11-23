/**
 * The owed line a project's master would be shown now, read without the verdict call (ISS-1421). The
 * box's `POST /me/master-session/verdict` is the only other place this line is composed, and it records
 * state on the master as it answers, so a judge (which may write nothing to prove a criterion) could
 * not see what a master owes: an owner's message a room left without a turn (ISS-1417) among it. This
 * read is the same composer (`owed.ts:readMasterWork`), for the box the verdict would be asked by, and
 * writes nothing.
 */

import type { MasterOwedRead } from '@forge/contracts/master-standing';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { refuseDevice } from '../devices/refusals.js';
import { liveMaster } from './live-master.js';
import { readMasterWork } from './owed.js';

export const MASTER_OWED_NO_BOX = 'MASTER_OWED_NO_BOX' as const;

type Box = { id: string; name: string | null };

/** The project's runner box its runner row last saw: the box a master would be placed on. */
async function runnerBox(projectId: string): Promise<Box | null> {
  const [row] = [
    ...((await db.execute(sql`
      SELECT r.device_id AS id, d.name
        FROM runners r LEFT JOIN devices d ON d.id = r.device_id
       WHERE r.project_id = ${projectId}::uuid
       ORDER BY r.last_seen_at DESC NULLS LAST, r.created_at DESC
       LIMIT 1`)) as unknown as Iterable<Box>),
  ];
  return row ?? null;
}

/**
 * What the project's master is owed now: read for its live master's box, else for the runner box a
 * master would be placed on, since the admissible line and the run slots are read per box. A project
 * with no box at all is refused by name: no master can be shown anything there.
 */
export async function readMasterOwedNow(projectId: string): Promise<MasterOwedRead> {
  const master = await liveMaster(projectId);
  const box: Box | null = master?.device_id
    ? { id: master.device_id, name: master.device_name }
    : await runnerBox(projectId);
  if (!box) {
    throw refuseDevice(
      MASTER_OWED_NO_BOX,
      `project ${projectId} has no live master and no runner box, so no master is shown an owed line here; bind a box to the project (\`forge-runner bind\`) and read again`,
    );
  }
  const { work, waits } = await readMasterWork(box.id, projectId);
  return {
    generatedAt: new Date().toISOString(),
    projectId,
    device: box,
    sessionId: master?.id ?? null,
    work,
    waits,
  };
}
