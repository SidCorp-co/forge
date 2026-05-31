// web-v2 feature module: activity. Types mirror the EXACT shape returned by
// `packages/core/src/issues/activity-routes.ts` (verified ISS-296). The feed is
// assembled client-side by fanning `GET /api/projects/:id/activity` across the
// caller's projects (there is no cross-project activity route).

export type ActorType = "user" | "device";

/** One row of `GET /api/projects/:id/activity`. `action` is a dotted verb like
 *  `issue.statusChanged` / `comment.created`; `payload` shape depends on it. */
export interface ActivityRow {
  id: string;
  issueId: string;
  action: string;
  actorType: ActorType;
  actorId: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/** `{ items, nextBefore }` cursor envelope. `nextBefore` is null on the last page. */
export interface ActivityFeedPage {
  items: ActivityRow[];
  nextBefore: string | null;
}

/** A feed row enriched with the project it belongs to (for cross-project view). */
export interface FeedRow extends ActivityRow {
  projectId: string;
  projectName: string;
}
