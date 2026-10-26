import { organizationMembers, organizations, projectMembers, projects } from '../db/schema.js';

export const PROJECT_LIST = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
  orgName: organizations.name,
  orgIsPersonal: organizations.isPersonal,
  createdBy: projects.createdBy,
  memberRole: projectMembers.role,
  orgRole: organizationMembers.role,
  issuePrefix: projects.issuePrefix,
  archivedAt: projects.archivedAt,
  createdAt: projects.createdAt,
} as const;

export const CREATED_PROJECT = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
  createdBy: projects.createdBy,
  createdAt: projects.createdAt,
} as const;

/** `forge_projects.get`, and the answer of an update that wrote only `environments.limits`. */
export const PROJECT_SUMMARY = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  description: projects.description,
  orgId: projects.orgId,
  createdBy: projects.createdBy,
  kind: projects.kind,
  repoPath: projects.repoPathHint,
  workspaceSetup: projects.workspaceSetup,
  baseBranch: projects.baseBranch,
  releaseChain: projects.releaseChain,
  defaultDeviceId: projects.defaultDeviceId,
  environments: projects.environments,
  createdAt: projects.createdAt,
} as const;

/** `forge_projects.update`. */
export const UPDATED_PROJECT = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
  description: projects.description,
  repoPath: projects.repoPathHint,
  workspaceSetup: projects.workspaceSetup,
  baseBranch: projects.baseBranch,
  releaseChain: projects.releaseChain,
  kind: projects.kind,
} as const;

export const PATCHED_PROJECT = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
  createdBy: projects.createdBy,
  description: projects.description,
  kind: projects.kind,
  repoPath: projects.repoPathHint,
  repoUrl: projects.repoUrl,
  workspaceSetup: projects.workspaceSetup,
  baseBranch: projects.baseBranch,
  releaseChain: projects.releaseChain,
  defaultDeviceId: projects.defaultDeviceId,
  agentConfig: projects.agentConfig,
  environments: projects.environments,
  issuePrefix: projects.issuePrefix,
  createdAt: projects.createdAt,
};

/** The GET /:id detail projection: `PATCHED_PROJECT` plus the fields only a read returns. */
export const PROJECT_DETAIL = {
  ...PATCHED_PROJECT,
  archivedAt: projects.archivedAt,
} as const;

export const ARCHIVED_PROJECT = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
  createdBy: projects.createdBy,
  archivedAt: projects.archivedAt,
  createdAt: projects.createdAt,
} as const;
