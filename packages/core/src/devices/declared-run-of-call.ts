// The run a box credential names by id, where a master on that box declared it (ISS-992's ledger).
// The runs a master declares run inside its pane, every one under the box's own credential, so the
// token cannot say which run made a call; the call names it, by the session id core issued, core's
// run id, or the run id the box declared (`issues/pattern-runs.ts` reads a verdict's `run` the same
// way). Core admitted that run on that box for that project, which is what binds it to both.

import {
  REVIEW_RUN_METADATA_KEY,
  type ReviewRunDeclaration,
  RUN_GROUP_METADATA_KEY,
  RUN_SESSION_KIND,
  readReviewRun,
} from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/session-vocabulary.js';
import { canonicalIssueKeySql } from '../lib/issue-run-group.js';

export type DeclaredRunRead =
  /** No run this box declared answers to the id: not a declared run, or one the box has not recorded at core yet. */
  | { kind: 'none' }
  | { kind: 'refused'; reason: 'ended' | 'queued' | 'foreign'; detail: string }
  | {
      kind: 'run';
      sessionId: string;
      runId: string;
      projectId: string;
      /** The issues the run was declared over, in its project. */
      issueIds: string[];
      /** Where a person declared it for review (`devices/review-run.ts`): who, its profile, its end. */
      review: ReviewRunDeclaration | null;
    };

interface Row {
  session_id: string;
  status: string;
  project_id: string;
  run_id: string;
  run_group: unknown;
  review: unknown;
}

/** The projects a credential reaches, where it is fenced to some; null where it names none. */
function fencedTo(caller: {
  boundProjectId: string | null;
  projectIds: readonly string[] | null;
}): readonly string[] | null {
  if (caller.boundProjectId) return [caller.boundProjectId];
  return caller.projectIds && caller.projectIds.length > 0 ? caller.projectIds : null;
}

/**
 * The run `asked` names among those declared on the caller's box. A credential bound or fenced to
 * projects names runs of those alone. The box's own credential names none (a box paired by a person
 * is fenced to no project, `devices/credential.ts:issueDeviceCredential`); it names the runs of a
 * project the box still serves, since core admitted each run there.
 */
async function servesProject(deviceId: string, projectId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM runners WHERE device_id = ${deviceId} AND project_id = ${projectId} LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

export async function declaredRunOfCall(
  caller: {
    deviceId: string | null;
    boundProjectId: string | null;
    projectIds: readonly string[] | null;
  },
  asked: string,
): Promise<DeclaredRunRead> {
  if (!caller.deviceId) return { kind: 'none' };
  const [row] = (await db.execute(sql`
    SELECT s.id AS session_id, s.status, s.project_id, r.id AS run_id,
           r.metadata -> ${RUN_GROUP_METADATA_KEY} AS run_group,
           jsonb_build_object(${REVIEW_RUN_METADATA_KEY}::text, r.metadata -> ${REVIEW_RUN_METADATA_KEY}) AS review
      FROM agent_sessions s
      JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.device_id = ${caller.deviceId}
       AND s.kind = ${RUN_SESSION_KIND}
       -- compared as text: an id that is no session's names none, never a failed query
       AND (s.id::text = ${asked} OR r.id::text = ${asked} OR r.metadata->>'boxRunId' = ${asked})
     ORDER BY s.created_at DESC
     LIMIT 1
  `)) as unknown as Row[];
  if (!row) return { kind: 'none' };
  const named = `run ${asked} (session ${row.session_id})`;
  const fence = fencedTo(caller);
  if (fence && !fence.includes(row.project_id)) {
    return {
      kind: 'refused',
      reason: 'foreign',
      detail: `${named} works project ${row.project_id}, and this credential reaches ${fence.join(', ')} only; a run reads only its own project's testing secrets, under a credential of that project.`,
    };
  }
  if (!fence && !(await servesProject(caller.deviceId, row.project_id))) {
    return {
      kind: 'refused',
      reason: 'foreign',
      detail: `${named} works project ${row.project_id}, which this box no longer serves (no runner of it is bound here), so its own credential reads nothing of that project.`,
    };
  }
  if ((terminalAgentSessionStatuses as readonly string[]).includes(row.status)) {
    return {
      kind: 'refused',
      reason: 'ended',
      detail: `${named} has ended (\`${row.status}\`), so it judges nothing now; a run reads testing secrets only while it runs.`,
    };
  }
  const review = readReviewRun(row.review);
  if (review && Date.parse(review.expiresAt) <= Date.now()) {
    return {
      kind: 'refused',
      reason: 'ended',
      detail: `${named} is a review run a person declared, and it ended at ${review.expiresAt}; declare another (POST /api/projects/${row.project_id}/review-runs) to read again.`,
    };
  }
  if (row.status === 'queued') {
    return {
      kind: 'refused',
      reason: 'queued',
      detail: `${named} is declared and queued: core has not admitted it, so it runs nothing yet. Read the secrets once the run is admitted.`,
    };
  }
  const keys = Array.isArray(row.run_group)
    ? row.run_group.filter((k): k is string => typeof k === 'string')
    : [];
  const issues =
    keys.length === 0
      ? []
      : ((await db.execute(sql`
          SELECT id FROM issues
           WHERE project_id = ${row.project_id}
             AND ${canonicalIssueKeySql(sql`iss_seq`)} IN (${sql.join(
               keys.map((k) => sql`${k}`),
               sql`, `,
             )})
           ORDER BY iss_seq
        `)) as unknown as Array<{ id: string }>);
  return {
    kind: 'run',
    sessionId: row.session_id,
    runId: row.run_id,
    projectId: row.project_id,
    issueIds: issues.map((i) => i.id),
    review,
  };
}

/** A live run a master declared on some box, as told to a credential that carries no box. */
export interface DeclaredRunElsewhere {
  /** The box the run was declared on, by its name. */
  box: string;
  /** The issues it was declared over, as keys. */
  keys: string[];
}

/**
 * The live run `asked` names on any box, where the caller's account is a member of its project: a
 * credential that carries no box cannot read under a run, so the refusal names the box whose
 * credential can (adminhub-api FB-379). A run of a project the account is no member of is not named.
 */
export async function declaredRunElsewhere(
  caller: { userId: string },
  asked: string,
): Promise<DeclaredRunElsewhere | null> {
  const [row] = (await db.execute(sql`
    SELECT d.name AS box, r.metadata -> ${RUN_GROUP_METADATA_KEY} AS run_group
      FROM agent_sessions s
      JOIN pipeline_runs r ON r.id = s.pipeline_run_id
      JOIN devices d ON d.id = s.device_id
      JOIN project_members m ON m.project_id = s.project_id AND m.user_id = ${caller.userId}
     WHERE s.kind = ${RUN_SESSION_KIND}
       AND s.status NOT IN (${sql.join(
         terminalAgentSessionStatuses.map((st) => sql`${st}`),
         sql`, `,
       )})
       AND (s.id::text = ${asked} OR r.id::text = ${asked} OR r.metadata->>'boxRunId' = ${asked})
     ORDER BY s.created_at DESC
     LIMIT 1
  `)) as unknown as Array<{ box: string; run_group: unknown }>;
  if (!row) return null;
  const keys = Array.isArray(row.run_group)
    ? row.run_group.filter((k): k is string => typeof k === 'string')
    : [];
  return { box: row.box, keys };
}
