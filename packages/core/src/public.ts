// Public type surface for `@forge/contracts` consumers.
//
// Only types/schemas meant to leak to clients live here. Runtime values
// (Drizzle table objects) are re-exported because `$inferSelect` needs them,
// but downstream consumers MUST use `import type` so no runtime code from
// `@forge/core` ends up bundled into `web`.

export { type LoginInput, loginSchema } from './auth/login.js';
export { type RegisterInput, registerSchema } from './auth/register.js';
export { BODY_FORMATS, type BodyFormat, type BodyNode } from './body/index.js';
export * as schema from './db/schema.js';
export type {
  AgentPath,
  AgentPathKind,
  IntegrationCapabilities,
  IntegrationProvider,
} from './integrations/types.js';
export {
  type ReleaseNotes,
  ReleaseNotesSchema,
  type ReleaseNotesSection,
  ReleaseNotesSectionSchema,
  releaseNotesSections,
} from './issues/release-notes.js';
export {
  type IssueCreateInput,
  type IssueFilters,
  type IssuePatchInput,
  issueCreateSchema,
  issueFiltersSchema,
  issuePatchSchema,
} from './issues/routes.js';
export {
  type EnvironmentsConfig,
  environmentsPatchSchema,
  type LiveEnvironment,
  type NormalizedEnvironments,
  normalizeEnvironments,
  type PreviewEnvironment,
  type TestCredential,
  type TestingUrl,
} from './projects/environments.js';
export {
  type CreateProjectInput,
  createProjectSchema,
  type UpdateProjectInput,
  updateProjectSchema,
} from './projects/routes.js';
