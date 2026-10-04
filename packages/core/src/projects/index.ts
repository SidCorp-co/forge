export type { KnowledgeObligation } from './autonomous-contract.js';
export { missingProjectKnowledge } from './autonomous-contract.js';
export { registerLiveReadingInvalidation } from './live-reading.js';
export { type AssignPrefixResult, type PrefixWriter, provideProjectsPorts } from './ports.js';
export type { RESERVED_PROJECT_FACT_KEYS } from './project-facts.js';
export { ALWAYS_INJECT_MAX_CHARS, unreservedProjectKeyRefusal } from './project-facts.js';
export { resolveEffectiveProjectId, resolveProjectIdFromSlug } from './project-scope.js';
export { listProjectHeads, projectHead } from './read.js';
export {
  type CreateProjectInput,
  createProjectSchema,
  type UpdateProjectInput,
  updateProjectSchema,
} from './request-schemas.js';
export {
  findProjectIdBySlug,
  findProjectOrgId,
  listVisibleProjectsWithRole,
  projectDocumentNames,
  type VisibleProjectWithRole,
} from './service.js';
// Loaded on call: the live reading reaches git and the release path, and both import this face back.
export const liveReachForIssue: typeof import('./live-reach-read.js').liveReachForIssue = async (
  ...args
) => (await import('./live-reach-read.js')).liveReachForIssue(...args);
export { declaredIssueSeqs, subjectOf } from './commit-owners.js';
export { issueRefPattern } from './live-reach.js';
