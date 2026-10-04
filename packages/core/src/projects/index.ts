export type { KnowledgeObligation } from './autonomous-contract.js';
export { missingProjectKnowledge } from './autonomous-contract.js';
export { registerLiveReadingInvalidation } from './live-reading.js';
export type { RESERVED_PROJECT_FACT_KEYS } from './project-facts.js';
export { ALWAYS_INJECT_MAX_CHARS, unreservedProjectKeyRefusal } from './project-facts.js';
export { resolveEffectiveProjectId, resolveProjectIdFromSlug } from './project-scope.js';
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
  setProjectIssuePrefix,
  type VisibleProjectWithRole,
} from './service.js';
