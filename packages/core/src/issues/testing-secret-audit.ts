// A testing-secrets read by a run a master declared, on the activity of the issue it judges. A job's
// read is audited on its job's event log (`jobs/job-secret-scrub.ts:recordSecretResolve`); a declared
// run has no job, and the issue is the record its read is made for. The row names refs, never
// values, and is what the scrubber reads to know which values that run's session holds.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { recordActivityTx } from './activity.js';

export const RUN_SECRET_RESOLVE = 'testing_secrets.resolved';

export interface RunSecretResolve {
  issueId: string;
  sessionId: string;
  runId: string;
  deviceId: string;
  environment: string | null;
  profile: string;
  refs: string[];
  tokenId: string;
  /** The person who declared the run, where it is a review run (`devices/review-run.ts`). */
  declaredBy?: string;
}

/** Audit the read, committed before any value leaves. */
export async function recordRunSecretResolve(read: RunSecretResolve): Promise<void> {
  const { issueId, deviceId, ...payload } = read;
  await recordActivityTx(db, {
    issueId,
    actor: { type: 'device', id: deviceId, agency: 'agent' },
    action: RUN_SECRET_RESOLVE,
    payload: { ...payload, deviceId },
  });
}

/** The refs each declared-run session read, by the project they were read in. */
export async function runSecretRefsOfSession(
  sessionId: string,
): Promise<Array<{ projectId: string; refs: string[] }>> {
  const rows = (await db.execute(sql`
    SELECT i.project_id, a.payload -> 'refs' AS refs
      FROM activity_log a JOIN issues i ON i.id = a.issue_id
     WHERE a.action = ${RUN_SECRET_RESOLVE} AND a.payload ->> 'sessionId' = ${sessionId}
  `)) as unknown as Array<{ project_id: string; refs: unknown }>;
  return rows.map((r) => ({
    projectId: r.project_id,
    refs: Array.isArray(r.refs) ? r.refs.filter((x): x is string => typeof x === 'string') : [],
  }));
}
