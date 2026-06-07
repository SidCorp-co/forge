// Public type surface for `@forge/contracts` consumers.
//
// Only types/schemas meant to leak to clients live here. Runtime values
// (Drizzle table objects) are re-exported because `$inferSelect` needs them,
// but downstream consumers MUST use `import type` so no runtime code from
// `@forge/core` ends up bundled into `web`.

export * as schema from './db/schema.js';

export { loginSchema, type LoginInput } from './auth/login.js';
export { registerSchema, type RegisterInput } from './auth/register.js';

export {
  issueCreateSchema,
  issuePatchSchema,
  issueFiltersSchema,
  type IssueCreateInput,
  type IssuePatchInput,
  type IssueFilters,
} from './issues/routes.js';

export {
  createProjectSchema,
  updateProjectSchema,
  previewDeployPatchSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
  type PreviewDeployConfig,
} from './projects/routes.js';

export {
  ReleaseNotesSchema,
  ReleaseNotesSectionSchema,
  releaseNotesSections,
  type ReleaseNotes,
  type ReleaseNotesSection,
} from './issues/release-notes.js';

// Integration provider + capability descriptor surface for `@forge/contracts`.
// Type-only: the runtime `capabilitiesFor` / `DEFAULT_CAPABILITIES` values stay
// core-internal so no integration runtime leaks into clients. The owner /
// environment / delivery enums are already reachable via the `schema` namespace.
export type { IntegrationProvider, IntegrationCapabilities } from './integrations/types.js';
