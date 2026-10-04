import type { FeedbackPhase } from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { RequirementFeedbackItem } from '@forge/contracts/requirements';
import { feedbackLinksOf } from '../requirements/index.js';
import { summariesAs } from './about.js';
import type { ReadDoor } from './egress.js';

const ORDER: readonly FeedbackPhase[] = [
  'new',
  'reopened',
  'triaged',
  'resolved',
  'planned',
  'verified',
  'declined',
];
const CLOSED: readonly FeedbackPhase[] = ['verified', 'declined'];

// cm:why ISS-79: the requirement reads back every feedback item about it, by the one link query
// (`feedback-links.ts:feedbackLinksOf`), open first and in the order a person acts on them, each
// with the path that ties it here and the route that carries it
export async function requirementFeedbackAs(
  viewer: { userId: string; agency: ActorAgency },
  projectId: string,
  requirementId: string,
  door: ReadDoor = {},
): Promise<RequirementFeedbackItem[]> {
  const links = await feedbackLinksOf(projectId, [requirementId]);
  const via = new Map(links.map((l) => [l.feedbackId, l.via]));
  const summaries = await summariesAs(viewer, projectId, [...via.keys()], door);
  return summaries
    .map((s): RequirementFeedbackItem => {
      const type = via.get(s.id) ?? 'requirement';
      return {
        id: s.id,
        key: s.key,
        title: s.title,
        kind: s.kind,
        severity: s.severity,
        phase: s.phase,
        open: !CLOSED.includes(s.phase),
        via: { type, key: type === 'route' ? (s.route?.key ?? '') : s.target.key },
        route: s.route,
      };
    })
    .sort(
      (a, b) =>
        ORDER.indexOf(a.phase) - ORDER.indexOf(b.phase) ||
        Number(b.key.slice(3)) - Number(a.key.slice(3)),
    );
}
