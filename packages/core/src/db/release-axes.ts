import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { check, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { releaseVersionText } from './column-checks.js';

/** How a release crosses ONE edge of a chain, declared on the entry it crosses into. */
export const releaseCrossings = ['merge-branch', 'cherry-pick'] as const;
export type ReleaseCrossing = (typeof releaseCrossings)[number];

export const bindingRoles = ['deploy', 'service', 'source'] as const;
export type BindingRole = (typeof bindingRoles)[number];

const RELEASE_CHAIN_CHK = sql`projects_release_chain_ok(release_chain)`;

const BINDING_ROLE_CHK = sql`role IN ('deploy', 'service', 'source')`;

export const SERVICE_ROLE_PRED = sql`role = 'service'`;

/** Spread into `projects`' extras in `schema.ts`; the constraint name is what Postgres reports. */
export const releaseProjectChecks = {
  releaseChainChk: check('projects_release_chain_chk', RELEASE_CHAIN_CHK),
} as const;

export const agentAccessValues = ['none', 'all'] as const;
export type AgentAccess = (typeof agentAccessValues)[number];

const AGENT_ACCESS_CHK = sql`agent_access IN ('none', 'all')`;

/** Spread into `integrationBindings`' extras in `schema.ts`. */
export const bindingShapeChecks = {
  roleChk: check('integration_bindings_role_chk', BINDING_ROLE_CHK),
  agentAccessChk: check('integration_bindings_agent_access_chk', AGENT_ACCESS_CHK),
} as const;

/** A release's number and its ship stamp; both NULL on every run that is not a release. */
export const releaseRunVersionColumns = {
  releaseVersion: text('release_version'),
  releaseReleasedAt: timestamp('release_released_at', { withTimezone: true }),
} as const;

/** Unique per project and `int[]`-comparable: what makes that number an identity. Partial, so it
 *  says nothing about a run that is not a release. The rules: `release-batch/version-store.ts`. */
export function releaseRunIdentity(t: { projectId: AnyPgColumn; releaseVersion: AnyPgColumn }) {
  return {
    releaseVersionUq: uniqueIndex('pipeline_runs_release_version_uq')
      .on(t.projectId, t.releaseVersion)
      .where(sql`release_version IS NOT NULL`),
    releaseVersionChk: check(
      'pipeline_runs_release_version_chk',
      releaseVersionText(t.releaseVersion),
    ),
  } as const;
}
