// The issues half of a verified deploy's probe replay (REQ-36 BC-12; ISS-470): which kept probes the
// deploy replays, and the verdict each result writes on the served identity. The release run runs
// the probes (`release-batch/probe-replay.ts`); nothing here runs one.
//
// A criterion is replayed where its latest verdict is earned (pass or short) and rests on a kept
// probe, on an issue already closed or on the releasing run's own roster: the code of both is what
// the deploy serves. A criterion QA passed with no probe kept is not replayed.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { isRefusal } from '../../lib/refusal.js';
import type { TransitionActor } from '../actor-agency.js';
import { actorAgency } from '../actor-agency.js';
import { recordVerdict, type VerdictAuthor } from './verdict-record.js';

export interface ReplayTarget {
  issueId: string;
  projectId: string;
  status: IssueStatus;
  reopenCount: number;
  /** Whether the releasing run claims it, rather than an earlier release having closed it. */
  claimed: boolean;
  criterion: number;
  /** The earned verdict the criterion stands on now. */
  standing: 'pass' | 'short';
  probeId: string;
  /** The kept probe as stored; the replayer reads it through the probe contract. */
  probe: unknown;
}

type TargetRow = {
  issue_id: string;
  project_id: string;
  status: IssueStatus;
  reopen_count: number;
  claimed: boolean;
  n: number;
  verdict: 'pass' | 'short';
  probe_id: string;
  spec: unknown;
};

/** The kept probes a verified deploy of `projectId` by run `runId` replays, issue by issue. */
export async function replayTargetsOf(projectId: string, runId: string): Promise<ReplayTarget[]> {
  const rows = (await db.execute(sql`
    SELECT i.id AS issue_id, i.project_id, i.status, i.reopen_count,
           (i.release_batch_run_id IS NOT DISTINCT FROM ${runId}::uuid) AS claimed,
           c.n, v.verdict, p.id AS probe_id, p.spec
      FROM issues i
      JOIN issue_criteria c ON c.issue_id = i.id AND c.retired_at IS NULL
      JOIN LATERAL (
        SELECT cv.verdict, cv.probe_id FROM criterion_verdicts cv
         WHERE cv.criterion_id = c.id
         ORDER BY cv.created_at DESC, cv.id DESC LIMIT 1
      ) v ON true
      JOIN LATERAL (
        SELECT cp.id, cp.spec FROM criterion_probes cp
         WHERE cp.criterion_id = c.id
         ORDER BY cp.created_at DESC, cp.id DESC LIMIT 1
      ) p ON true
     WHERE i.project_id = ${projectId}
       AND i.archived_at IS NULL
       AND (i.status = 'closed' OR i.release_batch_run_id = ${runId}::uuid)
       AND v.verdict IN ('pass', 'short')
       AND v.probe_id IS NOT NULL
     ORDER BY i.iss_seq, c.n
  `)) as unknown as TargetRow[];
  return rows.map((r) => ({
    issueId: r.issue_id,
    projectId: r.project_id,
    status: r.status,
    reopenCount: r.reopen_count,
    claimed: r.claimed,
    criterion: r.n,
    standing: r.verdict,
    probeId: r.probe_id,
    probe: r.spec,
  }));
}

export interface ReplayVerdict {
  target: ReplayTarget;
  verdict: 'pass' | 'short' | 'fail';
  reason: string;
  /** The commit the deploy serves: the verdict's runtime identity. */
  served: string;
  /** The URL the probe was sent to. */
  evidence: string;
}

/** The release's requester as a verdict's author: a box is an agent, an account its own agency. */
export function verdictAuthorOf(actor: TransitionActor): VerdictAuthor {
  return {
    userId: actor.type === 'user' ? actor.id : null,
    deviceId: actor.type === 'device' ? actor.id : null,
    agency: actorAgency(actor),
  };
}

/**
 * Each replay result's verdict on the served identity, through the one verdict writer, resting on
 * the kept probe it replayed. A verdict the writer refuses by name is answered as that refusal and
 * the others still land: each is written in a savepoint of its own.
 */
export async function recordReplayVerdicts(
  tx: Tx,
  verdicts: readonly ReplayVerdict[],
  actor: TransitionActor,
): Promise<Array<{ id: string } | { refused: string }>> {
  const author = verdictAuthorOf(actor);
  const out: Array<{ id: string } | { refused: string }> = [];
  for (const v of verdicts) {
    try {
      out.push(
        await tx.transaction(async (inner) =>
          recordVerdict(inner, {
            issue: { id: v.target.issueId, projectId: v.target.projectId },
            draft: {
              criterion: v.target.criterion,
              verdict: v.verdict,
              reason: v.reason,
              identity: { kind: 'runtime', ref: v.served },
              evidence: [v.evidence],
            },
            author,
          }),
        ),
      );
    } catch (err) {
      if (!isRefusal(err)) throw err;
      out.push({ refused: err.message });
    }
  }
  return out;
}
