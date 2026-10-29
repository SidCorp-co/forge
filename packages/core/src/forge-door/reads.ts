/**
 * What the Forge door answers about items of feedback about Forge (REQ-47): each with its phase, where
 * it came from and the same progress block the project door gives (`product-progress/feedback-views.ts`). A
 * reporter reads their own items without being a member of the home project (BC-3); the door decides
 * which items they are shown before anything here reads them.
 */

import type { FeedbackShipEvidence, FeedbackSummary } from '@forge/contracts/feedback';
import type { FeedbackToldView, ForgeFeedbackItem } from '@forge/contracts/forge-feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import { listFeedbackIn, type ReadDoor, withDuplicateRoots } from '../feedback/index.js';
import {
  type ForecastViewer,
  forecastViewerOf,
  readFeedbackForecastsOver,
} from '../forecast/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { holds } from '../permissions/index.js';
import {
  type FeedbackReads,
  feedbackProgress,
  issuesOfRequirements,
  liveRunsByIssue,
  requirementIdsOf,
  routedRequirements,
} from '../product-progress/index.js';

export interface ForgeViewer {
  userId: string;
  agency: ActorAgency;
}

/** Whether the viewer reads the home project as a member does: every item, not only their own. */
export async function readsHomeAsMember(homeId: string, userId: string): Promise<boolean> {
  const access = await effectiveProjectRole(userId, homeId);
  return access !== null && holds(access, 'project.read');
}

async function forecastViewer(homeId: string, userId: string): Promise<ForecastViewer> {
  if (await readsHomeAsMember(homeId, userId)) return forecastViewerOf(homeId, userId);
  return { userId, isAdmin: false, mayApprove: false, canWrite: false };
}

/**
 * The home project's items `ids` names, with the roots they duplicate, and what their progress reads
 * share, read once per answer. Read by id, never through the project list's page window, so an item
 * of the reporter's is never dropped for being older than the newest page (REQ-47 BC-3).
 */
export async function homeReads(
  viewer: ForgeViewer,
  homeId: string,
  door: ReadDoor,
  ids: readonly string[],
): Promise<{ all: FeedbackSummary[]; reads: FeedbackReads }> {
  const listed = await listFeedbackIn(
    viewer,
    homeId,
    { ids: await withDuplicateRoots(homeId, ids) },
    door,
  );
  if (!listed.ok) {
    throw new Error(
      `forge feedback: the home project's list refused a read by id: ${listed.refusals[0]?.detail}`,
    );
  }
  const all = listed.list.feedback;
  const [forecasts, runs, reqIds] = await Promise.all([
    readFeedbackForecastsOver(all, homeId, await forecastViewer(homeId, viewer.userId)),
    liveRunsByIssue(homeId, viewer.userId),
    requirementIdsOf(homeId, routedRequirements(all)),
  ]);
  const issues = await issuesOfRequirements(homeId, [...reqIds.values()]);
  return {
    all,
    reads: {
      asOf: forecasts.asOf,
      forecasts: new Map(forecasts.items.map((f) => [f.key, f])),
      runs,
      requirementIssues: new Map([...reqIds].map(([key, id]) => [key, issues.get(id) ?? []])),
      items: new Map(all.map((s) => [s.key, s])),
    },
  };
}

export function forgeItemOf(
  s: FeedbackSummary,
  reads: FeedbackReads,
  shipEvidence: FeedbackShipEvidence | null,
  told: FeedbackToldView,
): ForgeFeedbackItem {
  return {
    key: s.key,
    title: s.title,
    kind: s.kind,
    severity: s.severity,
    phase: s.phase,
    route: s.route && { route: s.route.route, carriers: s.route.carriers.map((c) => c.key) },
    origin: s.origin,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    progress: feedbackProgress(s, reads),
    shipEvidence,
    told,
  };
}
