import type { FeedbackSummary } from '@forge/contracts/feedback';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { feedbackEgress, type ReadDoor } from './egress.js';
import { linkedOf, summaryOf, viewerCanIn } from './list-read.js';
import type { FeedbackActor } from './read.js';

// Feedback read from another entity's page (a requirement's rail) passes the same egress
// rule as the Feedback list: a provider-bound reader gets metadata only at no_egress and scrubbed
// text at redact, whatever surface carries it, so a product read never leaks operational content
export async function summariesAs(
  viewer: FeedbackActor,
  projectId: string,
  ids: readonly string[],
  door: ReadDoor = {},
): Promise<FeedbackSummary[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(feedback)
    .where(inArray(feedback.id, [...ids]));
  const mine = rows.filter((r) => r.projectId === projectId);
  const [level, linked, can] = await Promise.all([
    dataPolicyOf(projectId),
    linkedOf(projectId, mine),
    viewerCanIn(viewer.userId, projectId),
  ]);
  const { withhold, shown } = feedbackEgress(level, viewer.agency, door);
  return shown(
    mine.map((r) => summaryOf(r, linked, viewer, withhold, can)),
    'feedback about this requirement',
  );
}
