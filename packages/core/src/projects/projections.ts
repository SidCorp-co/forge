import { projects } from '../db/schema.js';

export const PATCHED_PROJECT = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
  createdBy: projects.createdBy,
  baseBranch: projects.baseBranch,
  agentConfig: projects.agentConfig,
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
  baseBranch: projects.baseBranch,
  agentConfig: projects.agentConfig,
  webhookSecret: projects.webhookSecret,
  apiKey: projects.apiKey,
  issuePrefix: projects.issuePrefix,
  archivedAt: projects.archivedAt,
  createdAt: projects.createdAt,
} as const;
