/**
 * `awaiting_release` → `reopen` while a running release batch claims the issue: refused
 * `ISSUE_REOPEN_RELEASING`, by any actor, naming the batch and its version. The release ships the
 * issue's code whatever its status says, so a reopen mid-release left forge-dev ISS-635 reading
 * `reopen` over code dev.287 shipped. The one move that may is the claiming release's own probe
 * replay sending back a member its failing probe names, which reaches the kernel only through
 * `apply-transition.ts:reopenAsItsRelease`: the run it names is no option a door can pass. Once the
 * batch finishes its claim is no longer live, and a reopen is a reopen again.
 */

import { LIVE_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { Refusal } from '../lib/refusal.js';

export async function releaseClaimRefusal(
  tx: Pick<Tx, 'execute'>,
  issueId: string,
  replayOf: string | null,
): Promise<Refusal | null> {
  const [claim] = (await tx.execute(sql`
    SELECT r.id::text AS run, r.status,
           coalesce(r.release_version, r.metadata ->> 'version') AS version
      FROM issues i
      JOIN pipeline_runs r ON r.id = i.release_batch_run_id
     WHERE i.id = ${issueId}
  `)) as unknown as Array<{ run: string; status: string; version: string | null }>;
  if (!claim || !(LIVE_PIPELINE_RUN_STATUSES as readonly string[]).includes(claim.status)) {
    return null;
  }
  if (replayOf === claim.run) return null;
  const named = claim.version
    ? `${claim.version} (batch ${claim.run})`
    : `batch ${claim.run}, no version cut yet`;
  return {
    code: 'ISSUE_REOPEN_RELEASING',
    path: '/status',
    detail: `release ${named} is still ${claim.status} and claims this issue: its code ships with that release whatever the issue's status says, so it cannot be reopened mid-release. Reopen it once the release finishes; a probe the release replays and sees fail sends it back itself.`,
    details: { runId: claim.run, version: claim.version, status: claim.status },
  } as Refusal;
}
