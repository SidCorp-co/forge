export type { KnowledgeObligation } from './autonomous-contract.js';
export { missingProjectKnowledge } from './autonomous-contract.js';
export { registerLiveReadingInvalidation } from './live-reading.js';
export { type AssignPrefixResult, type PrefixWriter, provideProjectsPorts } from './ports.js';
export type { RESERVED_PROJECT_FACT_KEYS } from './project-facts.js';
export { unreservedProjectKeyRefusal } from './project-facts.js';
export { resolveEffectiveProjectId, resolveProjectIdFromSlug } from './project-scope.js';
export { listProjectHeads, projectCreatorOf, projectHead, projectOrgHead } from './read.js';
export {
  type CreateProjectInput,
  createProjectSchema,
  type UpdateProjectInput,
  updateProjectSchema,
} from './request-schemas.js';
export {
  findProjectIdBySlug,
  findProjectOrgId,
  findProjectOrgIds,
  listVisibleProjectsWithRole,
  projectDocumentNames,
  projectOrgIdSql,
  type VisibleProjectWithRole,
} from './service.js';
// Loaded on call: the live reading reaches git and the release path, and both import this face back.
export const liveReachForIssue: typeof import('./live-reach-read.js').liveReachForIssue = async (
  ...args
) => (await import('./live-reach-read.js')).liveReachForIssue(...args);
export type { ReadingOwnership } from './commit-owners.js';
export { declaredIssueSeqs, readingOwnership, subjectOf, unclaimedShas } from './commit-owners.js';
export { issueWorkRecordsAt } from './issue-work-records.js';
export type { LiveReading } from './live-reach.js';
export { evidenceFor, issueRefPattern } from './live-reach.js';
export { liveReadingForRow, projectReleaseRows } from './live-reading.js';
