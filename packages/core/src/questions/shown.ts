// A question as the project's data policy lets its reader see it, read by both doors: REST's question
// routes and the MCP door's `forge_questions`.

import { type EgressReader, egressAs } from '../lib/data-egress.js';
import { questionSurface } from './read.js';

export type ShownQuestion = {
  id: string;
  status: string;
  projectId: string;
  issueId: string | null;
  feedbackId: string | null;
  requirementId: string | null;
  batchId: string | null;
};

/** The question as `reader` may see it; withheld text keeps its ids and says why. */
export async function shownQuestion<Q extends ShownQuestion>(reader: EgressReader, q: Q) {
  const out = await egressAs(reader, q.projectId, await questionSurface(q), q, `question ${q.id}`);
  return out.ok
    ? out.value
    : { id: q.id, status: q.status, issueId: q.issueId, withheld: out.refusal };
}
