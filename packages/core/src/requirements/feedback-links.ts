import type { FeedbackStatus } from '@forge/contracts/feedback';
import type { RequirementFeedbackVia } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { uuidArray } from '../db/raw-sql.js';
import { rowsPerId } from '../db/read-memo.js';

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

// ISS-79: the one answer to "which feedback is about this requirement", read by the detail,
// the standing's counts and the Feedback list's `requirement` filter alike, so the three never
// disagree. An item belongs to a requirement through its target (the requirement, one of its issues,
// a linked design, or a release that shipped one of its issues) or through its route (any issue, the
// revision suggestion or the draft requirement that carries it); the first path in that order names it
export async function feedbackLinksOf(
  projectId: string,
  requirementIds: readonly string[],
): Promise<FeedbackLink[]> {
  // every project's asks in one turn are read together, each answer keeping the feedback of the
  // project asked, as the read of that one project kept it (ISS-1070 r6)
  const rows = await rowsPerId(
    'feedbackLinks',
    requirementIds,
    linkRowsOf,
    (r) => r.requirement_id,
  );
  return rows
    .filter((r) => r.project_id === projectId)
    .map((r) => ({
      requirementId: r.requirement_id,
      feedbackId: r.feedback_id,
      fbSeq: Number(r.fb_seq),
      status: r.status,
      via: r.via,
    }));
}

/** Every feedback link of `requirementIds`, whatever project the feedback item is in. */
async function linkRowsOf(requirementIds: readonly string[]) {
  if (requirementIds.length === 0) return [];
  const ids = uuidArray(requirementIds);
  return (await db.execute(sql`
    WITH links AS (
      SELECT f.id AS fid, f.requirement_id AS rid, 'requirement' AS via, 1 AS rank
        FROM feedback f WHERE f.requirement_id = ANY(${ids})
      UNION ALL
      SELECT f.id, i.requirement_id, 'issue', 2
        FROM feedback f JOIN issues i ON i.id = f.issue_id
       WHERE i.requirement_id = ANY(${ids})
      UNION ALL
      SELECT f.id, rw.requirement_id, 'workflow', 3
        FROM feedback f JOIN requirement_workflows rw ON rw.workflow_id = f.workflow_id
       WHERE rw.requirement_id = ANY(${ids})
      UNION ALL
      SELECT f.id, i.requirement_id, 'release', 4
        FROM feedback f JOIN issues i ON i.release_batch_run_id = f.release_run_id
       WHERE i.requirement_id = ANY(${ids})
      UNION ALL
      SELECT f.id, i.requirement_id, 'route', 5
        FROM feedback f JOIN feedback_route_issues c ON c.feedback_id = f.id
        JOIN issues i ON i.id = c.issue_id
       WHERE i.requirement_id = ANY(${ids})
      UNION ALL
      SELECT f.id, s.requirement_id, 'route', 5
        FROM feedback f JOIN suggestions s ON s.id = f.routed_suggestion_id
       WHERE s.requirement_id = ANY(${ids})
      UNION ALL
      SELECT f.id, f.routed_requirement_id, 'route', 5
        FROM feedback f WHERE f.routed_requirement_id = ANY(${ids})
    )
    SELECT DISTINCT ON (l.rid, l.fid)
           l.rid AS requirement_id, f.project_id, l.fid AS feedback_id, f.fb_seq, f.status, l.via
      FROM links l JOIN feedback f ON f.id = l.fid
     ORDER BY l.rid, l.fid, l.rank`)) as unknown as (LinkRow & { project_id: string })[];
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
