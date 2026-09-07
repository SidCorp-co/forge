// Public type surface for `@forge/contracts` consumers.
//
// Only types/schemas meant to leak to clients live here. Runtime values
// (Drizzle table objects) are re-exported because `$inferSelect` needs them,
// but downstream consumers MUST use `import type` so no runtime code from
// `@forge/core` ends up bundled into `web`.

export { type LoginInput, loginSchema } from './auth/login.js';
export { type RegisterInput, registerSchema } from './auth/register.js';
// cm:guard ISS-898 — only the descriptor TYPES and the format union leak; the registry itself must stay core-internal because it is runtime code core executes on every write, and `contracts-runtime-boundary.test.ts` forbids core value-importing anything it hands to contracts
export {
  BODY_FORMATS,
  type BodyFormat,
  type BodyNode,
  COMPONENT_NAMES,
  type ComponentSpec,
  type ComponentView,
  ROOT_COMPONENT_NAMES,
} from './body/index.js';
export type {
  BodyAttrDescriptor,
  BodyComponentDescriptor,
  BodySlotDescriptor,
} from './body/registry-view.js';
export * as schema from './db/schema.js';
// cm:guard type-only: `capabilitiesFor` and `DEFAULT_CAPABILITIES` stay core-internal, or integration runtime is bundled into every client. The owner / environment / delivery enums are already reachable through the `schema` namespace.
export type { IntegrationCapabilities, IntegrationProvider } from './integrations/types.js';
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
  type CreateProjectInput,
  createProjectSchema,
  type PreviewDeployConfig,
  previewDeployPatchSchema,
  type UpdateProjectInput,
  updateProjectSchema,
} from './projects/routes.js';
