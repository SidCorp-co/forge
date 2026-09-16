/**
 * What the project REST doors project out of the `projects` row.
 *
 * Split out of `routes.ts` when reading `liveBranch` through the release model took that file
 * past the size it was frozen at (ISS-1046). A projection is data, not routing: these two lists
 * are the shape of the resource, and the only reason they lived beside the handlers is that they
 * were written there.
 *
 * Both carry `releaseModel` and `releaseStrategy`, and both are normalised through
 * `readableLiveBranch` at the handler — the column is returned to nobody without its model,
 * because "promotes to no branch" and "does not promote" are different answers and 25 of the 32
 * fleet projects carry a live branch nothing promotes to.
 */

import { projects } from '../db/schema.js';

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
  liveBranch: projects.liveBranch,
  releaseModel: projects.releaseModel,
  releaseStrategy: projects.releaseStrategy,
  defaultDeviceId: projects.defaultDeviceId,
  agentConfig: projects.agentConfig,
  previewDeploy: projects.previewDeploy,
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
  repoPath: projects.repoPath,
  repoUrl: projects.repoUrl,
  workspaceSetup: projects.workspaceSetup,
  baseBranch: projects.baseBranch,
  liveBranch: projects.liveBranch,
  releaseModel: projects.releaseModel,
  releaseStrategy: projects.releaseStrategy,
  defaultDeviceId: projects.defaultDeviceId,
  agentConfig: projects.agentConfig,
  previewDeploy: projects.previewDeploy,
  webhookSecret: projects.webhookSecret,
  apiKey: projects.apiKey,
  issuePrefix: projects.issuePrefix,
  archivedAt: projects.archivedAt,
  createdAt: projects.createdAt,
} as const;
