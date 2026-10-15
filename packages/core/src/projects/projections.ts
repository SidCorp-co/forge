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

export const PATCHED_PROJECT = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
  createdBy: projects.createdBy,
  description: projects.description,
  kind: projects.kind,
  repoPath: projects.repoPath,
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

/** No other projection names a credential column (`projections.test.ts`): rotation alone shows the key. */
export const ROTATED_API_KEY = { id: projects.id, apiKey: projects.apiKey } as const;
