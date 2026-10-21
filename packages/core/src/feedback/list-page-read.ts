/**
 * A project's feedback list as a viewer reads it: the items, the counts by attention group, and how
 * many reporters are still owed word that their fix shipped. Each item's derived facts are
 * `list-read.ts`'s; this is the query and the door's egress around them.
 */

import {
  FEEDBACK_ATTENTION_GROUPS,
  type FeedbackAttentionGroup,
  type FeedbackListResponse,
  type FeedbackPhase,
} from '@forge/contracts/feedback';
import { and, desc, eq, ilike, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { feedbackEgress, type ReadDoor } from './egress.js';
import { linkedOf, summaryOf, viewerCanIn } from './list-read.js';
import type { FeedbackActor } from './read.js';
import { feedbackIdsOfRequirement, NO_FEEDBACK } from './relations.js';
import { type FeedbackRefusal, searchWithheldRefusal } from './rules.js';

type ListQuery = {
  phases?: readonly FeedbackPhase[] | undefined;
  q?: string | undefined;
  requirement?: string | undefined;
  /**
   * The items a door has already chosen, read whole: no page window applies, so an item the door
   * names is never dropped for being older than the newest page (REQ-47 BC-3).
   */
  ids?: readonly string[] | undefined;
};

/** The newest items a project's own list shows; a door naming its items reads past it. */
const LIST_WINDOW = 500;
type ListAnswer =
  | { ok: true; list: FeedbackListResponse }
  | { ok: false; refusals: FeedbackRefusal[] };

export async function listFeedbackAs(
  viewer: FeedbackActor,
  projectId: string,
  query: ListQuery = {},
  door: ReadDoor = {},
): Promise<ListAnswer> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  return listFeedbackIn(viewer, projectId, query, door);
}

/**
 * The project's items as `viewer` reads them, with no check that they may: for a door that has
 * already decided what the viewer is shown, as the Forge door does for a reporter's own items
 * (REQ-47 BC-3), which the reporter reads without being a member of the project they sit in.
 */
export async function listFeedbackIn(
  viewer: FeedbackActor,
  projectId: string,
  query: ListQuery = {},
  door: ReadDoor = {},
): Promise<ListAnswer> {
  const level = await dataPolicyOf(projectId);
  const { withhold, shown } = feedbackEgress(level, viewer.agency, door);
  const searchRefused = searchWithheldRefusal(query.q, withhold);
  if (searchRefused) return { ok: false, refusals: [searchRefused] };
  const about = query.requirement
    ? await feedbackIdsOfRequirement(projectId, query.requirement)
    : null;
  const named = query.ids ? [...query.ids] : null;
  const rows = await db
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.projectId, projectId),
        query.q ? ilike(feedback.title, `%${query.q}%`) : undefined,
        about ? inArray(feedback.id, about.length ? about : [NO_FEEDBACK]) : undefined,
        named ? inArray(feedback.id, named.length ? named : [NO_FEEDBACK]) : undefined,
      ),
    )
    .orderBy(desc(feedback.createdAt))
    .limit(named ? Math.max(named.length, 1) : LIST_WINDOW);
  const [linked, can] = await Promise.all([
    linkedOf(projectId, rows),
    viewerCanIn(viewer.userId, projectId),
  ]);
  const all = shown(
    rows.map((r) => summaryOf(r, linked, viewer, withhold, can)),
    'the feedback list',
  );
  const listed = query.phases?.length ? all.filter((s) => query.phases?.includes(s.phase)) : all;
  const counts = Object.fromEntries(FEEDBACK_ATTENTION_GROUPS.map((g) => [g, 0])) as Record<
    FeedbackAttentionGroup,
    number
  >;
  for (const s of all) counts[s.attentionGroup] += 1;
  const untold = {
    owed: all.filter((s) => s.reporterNotTold === 'owed').length,
    beforeNotices: all.filter((s) => s.reporterNotTold === 'before_notices').length,
    noticesBegan: linked.untold.noticesBegan,
  };
  return { ok: true, list: { feedback: listed, counts, untold, sensitive: level !== 'off' } };
}
