import type { RequirementSummaryView } from '@forge/contracts/requirements';
import type { listRequirementsAs } from './read.js';

type ListedRequirement = Awaited<ReturnType<typeof listRequirementsAs>>[number];

export function requirementSummaryOf(row: ListedRequirement): RequirementSummaryView {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    status: row.status,
    state: row.standing.state,
    currentRevision: row.currentRevision,
    latestRevision: row.latestRevision,
    counts: row.standing.facts,
    waitingOn: row.standing.waitingOn,
    updatedAt: row.updatedAt,
  };
}
