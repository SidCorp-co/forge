/**
 * What each issue a run carries is given when the run opens (REQ-1 BC-3, REQ-4 BC-12): the
 * requirement revision it was planned on and the one current now, the design revisions and contract
 * versions its requirement's latest baseline pins (`criteria-anchors.ts:pinnedAnchorsOf`), the
 * workflow it builds, and its live criteria with the BC each traces. The run open stores it on the
 * run (`RUN_GIVEN_METADATA_KEY`), and the run read serves it.
 */

import type { RunGiven, RunGivenIssue } from '@forge/contracts/run-standing';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { canonicalIssueKey } from '../lib/issue-ref.js';
import { pinnedAnchorsOf } from './criteria-anchors.js';

type Reader = Pick<Tx, 'execute'>;
type Rows = Array<Record<string, unknown>>;

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

export async function givenAtDispatch(
  exec: Reader,
  projectId: string,
  seqs: readonly number[],
): Promise<RunGiven> {
  if (seqs.length === 0) return {};
  const list = sql.join(
    seqs.map((n) => sql`${n}`),
    sql`, `,
  );
  const issues = (await exec.execute(sql`
    SELECT i.id, i.iss_seq, i.planned_revision, r.req_seq, r.current_revision,
           w.flow AS builds_flow, w.approved_revision AS builds_revision
      FROM issues i
      LEFT JOIN requirements r ON r.id = i.requirement_id
      LEFT JOIN workflow_builds wb ON wb.issue_id = i.id
      LEFT JOIN project_workflows w ON w.id = wb.workflow_id
     WHERE i.project_id = ${projectId} AND i.iss_seq IN (${list})
  `)) as unknown as Rows;
  const ids = issues.map((r) => String(r.id));
  if (ids.length === 0) return {};
  const criteria = (await exec.execute(sql`
    SELECT ic.issue_id, ic.n, rc.code
      FROM issue_criteria ic
      LEFT JOIN requirement_criteria rc ON rc.id = ic.requirement_criterion_id
     WHERE ic.retired_at IS NULL AND ic.issue_id IN (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})
     ORDER BY ic.n
  `)) as unknown as Rows;
  const anchors = await pinnedAnchorsOf(ids);
  const out: RunGiven = {};
  for (const r of issues) {
    const id = String(r.id);
    const pinned = anchors.get(id);
    const given: RunGivenIssue = {
      requirement:
        r.req_seq == null
          ? null
          : {
              key: `REQ-${Number(r.req_seq)}`,
              plannedRevision: r.planned_revision == null ? null : Number(r.planned_revision),
              currentRevision: r.current_revision == null ? null : Number(r.current_revision),
            },
      // the anchors hold each design under its flow and its id; the flow is what a person reads
      designs: [...(pinned?.designs ?? new Map<string, number>())]
        .filter(([flow]) => !isUuid(flow))
        .map(([flow, revision]) => ({ flow, revision })),
      contracts: [...(pinned?.contracts ?? new Map<string, string>())].map(
        ([contract, version]) => ({
          contract,
          version,
        }),
      ),
      builds:
        r.builds_flow == null
          ? null
          : {
              flow: String(r.builds_flow),
              approvedRevision: r.builds_revision == null ? null : Number(r.builds_revision),
            },
      criteria: criteria
        .filter((c) => String(c.issue_id) === id)
        .map((c) => ({ n: Number(c.n), traces: c.code == null ? null : String(c.code) })),
    };
    out[canonicalIssueKey(Number(r.iss_seq))] = given;
  }
  return out;
}
