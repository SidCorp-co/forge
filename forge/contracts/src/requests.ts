// Request input types. These are the Zod `z.infer` of the validators in
// `forge/core`. Keeping them in one place gives clients a stable surface
// without importing Zod at runtime.

export type {
  LoginInput,
  RegisterInput,
  IssueCreateInput,
  IssuePatchInput,
  IssueFilters,
  CreateProjectInput,
  UpdateProjectInput,
} from '@forge/core/public';
