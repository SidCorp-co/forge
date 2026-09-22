import { projects } from '../db/schema.js';

export const PATCHED_PROJECT = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
  createdBy: projects.createdBy,
  description: projects.description,
  previewShape: projects.previewShape,
  repoPath: projects.repoPath,
  repoUrl: projects.repoUrl,
  workspaceSetup: projects.workspaceSetup,
  baseBranch: projects.baseBranch,
  liveBranch: projects.liveBranch,
  releaseModel: projects.releaseModel,
  releaseStrategy: projects.releaseStrategy,
  defaultDeviceId: projects.defaultDeviceId,
  agentConfig: projects.agentConfig,
  environments: projects.environments,
  webhookSecret: projects.webhookSecret,
  issuePrefix: projects.issuePrefix,
  createdAt: projects.createdAt,
};

/** The GET /:id detail projection: `PATCHED_PROJECT` plus the fields only a read returns. */
export const PROJECT_DETAIL = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
  createdBy: projects.createdBy,
  description: projects.description,
  previewShape: projects.previewShape,
  repoPath: projects.repoPath,
  repoUrl: projects.repoUrl,
  workspaceSetup: projects.workspaceSetup,
  baseBranch: projects.baseBranch,
  liveBranch: projects.liveBranch,
  releaseModel: projects.releaseModel,
  releaseStrategy: projects.releaseStrategy,
  defaultDeviceId: projects.defaultDeviceId,
  agentConfig: projects.agentConfig,
  environments: projects.environments,
  webhookSecret: projects.webhookSecret,
  apiKey: projects.apiKey,
  issuePrefix: projects.issuePrefix,
  archivedAt: projects.archivedAt,
  createdAt: projects.createdAt,
} as const;

/**
 * The PATCH keys that are columns of `projects` and are written straight through.
 *
 * `environments` and `previewShape` are on this list rather than assigned later because
 * `releaseShapeGap` judges the row AS IT WILL BE, so both have to be in `updates` before it is
 * asked. ISS-1189.
 */
export const PATCHABLE_COLUMNS = [
  'name',
  'description',
  'kind',
  'repoPath',
  'repoUrl',
  'baseBranch',
  'workspaceSetup',
  'liveBranch',
  'releaseModel',
  'releaseStrategy',
  'previewShape',
  'environments',
  'webhookSecret',
  'defaultDeviceId',
] as const;
