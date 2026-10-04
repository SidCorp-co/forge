import type { FeedbackStatus } from '@forge/contracts/feedback';
import type { RequirementFeedbackVia } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

interface FeedbackLink {
  requirementId: string;
  feedbackId: string;
  fbSeq: number;
  status: FeedbackStatus;
  via: RequirementFeedbackVia;
}

type LinkRow = {
  requirement_id: string;
  feedback_id: string;
  fb_seq: number;
  status: FeedbackStatus;
  via: RequirementFeedbackVia;
};

// cm:why ISS-79: the one answer to "which feedback is about this requirement", read by the detail,
// the standing's counts and the Feedback list's `requirement` filter alike, so the three never
// disagree. An item belongs to a requirement through its target (the requirement, one of its issues,
// a linked design, or a release that shipped one of its issues) or through its route (the issue, the
// revision suggestion or the draft requirement that carries it); the first path in that order names it
export async function feedbackLinksOf(
  projectId: string,
  requirementIds: readonly string[],
): Promise<FeedbackLink[]> {
  if (requirementIds.length === 0) return [];
  const ids = sql`(${sql.join(
    requirementIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
  const rows = (await db.execute(sql`
    WITH links AS (
      SELECT f.id AS fid, f.requirement_id AS rid, 'requirement' AS via, 1 AS rank
        FROM feedback f WHERE f.project_id = ${projectId} AND f.requirement_id IN ${ids}
      UNION ALL
      SELECT f.id, i.requirement_id, 'issue', 2
        FROM feedback f JOIN issues i ON i.id = f.issue_id
       WHERE f.project_id = ${projectId} AND i.requirement_id IN ${ids}
      UNION ALL
      SELECT f.id, rw.requirement_id, 'workflow', 3
        FROM feedback f JOIN requirement_workflows rw ON rw.workflow_id = f.workflow_id
       WHERE f.project_id = ${projectId} AND rw.requirement_id IN ${ids}
      UNION ALL
      SELECT f.id, i.requirement_id, 'release', 4
        FROM feedback f JOIN issues i ON i.release_batch_run_id = f.release_run_id
       WHERE f.project_id = ${projectId} AND i.requirement_id IN ${ids}
      UNION ALL
      SELECT f.id, i.requirement_id, 'route', 5
        FROM feedback f JOIN issues i ON i.id = f.routed_issue_id
       WHERE f.project_id = ${projectId} AND i.requirement_id IN ${ids}
      UNION ALL
      SELECT f.id, s.requirement_id, 'route', 5
        FROM feedback f JOIN suggestions s ON s.id = f.routed_suggestion_id
       WHERE f.project_id = ${projectId} AND s.requirement_id IN ${ids}
      UNION ALL
      SELECT f.id, f.routed_requirement_id, 'route', 5
        FROM feedback f WHERE f.project_id = ${projectId} AND f.routed_requirement_id IN ${ids}
    )
    SELECT DISTINCT ON (l.rid, l.fid)
           l.rid AS requirement_id, l.fid AS feedback_id, f.fb_seq, f.status, l.via
      FROM links l JOIN feedback f ON f.id = l.fid
     ORDER BY l.rid, l.fid, l.rank`)) as unknown as LinkRow[];
  return [...rows].map((r) => ({
    requirementId: r.requirement_id,
    feedbackId: r.feedback_id,
    fbSeq: Number(r.fb_seq),
    status: r.status,
    via: r.via,
  }));
}

const UNTRIAGED: readonly FeedbackStatus[] = ['new', 'reopened'];
const CLOSED: readonly FeedbackStatus[] = ['verified', 'declined'];

interface FeedbackCounts {
  open: number;
  untriaged: string[];
}

export function feedbackCountsOf(links: readonly FeedbackLink[]): Map<string, FeedbackCounts> {
  const out = new Map<string, FeedbackCounts>();
  for (const l of [...links].sort((a, b) => a.fbSeq - b.fbSeq)) {
    const c = out.get(l.requirementId) ?? { open: 0, untriaged: [] };
    if (!CLOSED.includes(l.status)) c.open += 1;
    if (UNTRIAGED.includes(l.status)) c.untriaged.push(`FB-${l.fbSeq}`);
    out.set(l.requirementId, c);
  }
  return out;
}
