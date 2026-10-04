// Only types/schemas meant to leak to clients live here. Runtime values
// (Drizzle table objects) are re-exported because `$inferSelect` needs them,
// but downstream consumers MUST use `import type` so no runtime code from
// `@forge/core` ends up bundled into `web`.

export {
  type ReleaseNotes,
  ReleaseNotesSchema,
  type ReleaseNotesSection,
  ReleaseNotesSectionSchema,
  releaseNotesSections,
} from '@forge/contracts/release-notes';
export { type LoginInput, loginSchema, type RegisterInput, registerSchema } from './auth/index.js';
export { BODY_FORMATS, type BodyFormat, type BodyNode } from './body/index.js';
export * as schema from './db/schema.js';
export type {
  AgentPath,
  AgentPathKind,
  IntegrationCapabilities,
  IntegrationProvider,
} from './integrations/index.js';
export {
  type IssueCreateInput,
  type IssueFilters,
  type IssuePatchInput,
  issueCreateSchema,
  issueFiltersSchema,
  issuePatchSchema,
} from './issues/index.js';
export {
  type CreateProjectInput,
  createProjectSchema,
  type UpdateProjectInput,
  updateProjectSchema,
} from './projects/index.js';
