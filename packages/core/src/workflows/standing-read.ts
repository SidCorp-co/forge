// A workflow's standing (REQ-68 BC-5): the step its design is at, who it waits on and what is next,
// read with no viewer so the standing read, the steward and every page see one basis. The wait is
// `design-standing.ts:designWaitingOn`'s, the same the workflow page's banner reads; the times are
// `lib/standing-times.ts:withTimes`'s, the rule the requirement and feedback reads apply. An approved
// or withdrawn design, or a workflow under no approval, owes nobody a step and reads `done`.

import type { DesignStatus } from '@forge/contracts/design-status';
import type { StandingGroup, WaitingOn } from '@forge/contracts/standing';
import type { MasterServing, StandingTimes } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { withTimes } from '../lib/standing-times.js';
import { designWaitingOn } from './design-standing.js';

/** One workflow's standing: its flow is the key every page and note names it by. */
export interface WorkflowStanding {
  id: string;
  flow: string;
  /** The design step the workflow is at; null where it is under no approval. */
  step: DesignStatus | null;
  attentionGroup: StandingGroup;
  waitingOn: WaitingOn;
  times: StandingTimes;
}

interface Row {
  id: string;
  flow: string;
  design_status: DesignStatus | null;
  approved_revision: number | null;
  proposed_revision: number | null;
  latest_revision: number | null;
  since: string;
}

/** The design steps that owe somebody a step: the rest rest. */
const OWING: ReadonlySet<DesignStatus> = new Set(['draft', 'proposed', 'returned']);

/** One workflow's standing from its design facts, pure. */
export function workflowStandingOf(
  row: {
    id: string;
    flow: string;
    step: DesignStatus | null;
    approvedRevision: number | null;
    proposedRevision: number | null;
    /** The newest design revision, which a return names to revise; null where none was drawn. */
    latestRevision: number | null;
    since: Date;
  },
  master: MasterServing,
  now: Date,
): WorkflowStanding {
  const wait = designWaitingOn({
    status: row.step,
    proposedRevision: row.proposedRevision,
    approvedRevision: row.approvedRevision,
    latest: row.latestRevision === null ? null : { revision: row.latestRevision, author: null },
    canDecide: false,
  });
  const owing = row.step !== null && OWING.has(row.step);
  const { group, times } = withTimes<StandingGroup>(
    { group: owing ? 'waiting' : 'done', waitingOn: wait },
    { since: row.since, master, now },
    'waiting',
  );
  return {
    id: row.id,
    flow: row.flow,
    step: row.step,
    attentionGroup: group,
    waitingOn: wait,
    times,
  };
}

/**
 * Every workflow's standing in a project, by flow. Since when its wait stands is its newest design
 * record: the open revision's proposal, else the last decision, else the workflow's own last write.
 */
export async function workflowStandingsOf(
  projectId: string,
  master: MasterServing,
  now: Date = new Date(),
): Promise<WorkflowStanding[]> {
  const rows = rowsOf<Row>(
    await db.execute(sql`
      SELECT w.id, w.flow, w.design_status, w.approved_revision,
             CASE WHEN w.design_status = 'proposed' THEN d.revision END AS proposed_revision,
             d.revision AS latest_revision,
             GREATEST(w.updated_at, COALESCE(d.decided_at, d.proposed_at, w.updated_at)) AS since
        FROM project_workflows w
        LEFT JOIN LATERAL (
          SELECT revision, proposed_at, decided_at
            FROM project_workflow_designs
           WHERE workflow_id = w.id
           ORDER BY revision DESC
           LIMIT 1
        ) d ON true
       WHERE w.project_id = ${projectId}
       ORDER BY w.flow`),
  );
  return rows.map((r) =>
    workflowStandingOf(
      {
        id: r.id,
        flow: r.flow,
        step: r.design_status,
        approvedRevision: r.approved_revision === null ? null : Number(r.approved_revision),
        proposedRevision: r.proposed_revision === null ? null : Number(r.proposed_revision),
        latestRevision: r.latest_revision === null ? null : Number(r.latest_revision),
        since: new Date(r.since),
      },
      master,
      now,
    ),
  );
}
