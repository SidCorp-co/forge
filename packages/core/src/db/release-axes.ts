import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { check, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { releaseVersionText } from './column-checks.js';

export const bindingRoles = ['deploy', 'service', 'source'] as const;
export type BindingRole = (typeof bindingRoles)[number];

const BINDING_ROLE_CHK = sql`role IN ('deploy', 'service', 'source')`;

export const SERVICE_ROLE_PRED = sql`role = 'service'`;

export const agentAccessValues = ['none', 'all'] as const;
export type AgentAccess = (typeof agentAccessValues)[number];

const AGENT_ACCESS_CHK = sql`agent_access IN ('none', 'all')`;

export const bindingShapeChecks = {
  roleChk: check('integration_bindings_role_chk', BINDING_ROLE_CHK),
  agentAccessChk: check('integration_bindings_agent_access_chk', AGENT_ACCESS_CHK),
} as const;

/** A release's number and its ship stamp; both NULL on every run that is not a release. */
export const releaseRunVersionColumns = {
  releaseVersion: text('release_version'),
  releaseReleasedAt: timestamp('release_released_at', { withTimezone: true }),
} as const;

/** Unique per project among the rows still holding their number, and `int[]`-comparable. A run
 *  that ended unshipped leaves the index, so a re-cut of its roster may wear the number it tried;
 *  whether it may is `release-batch/version-rule.ts:decideVersion`'s to say, and this is the backstop. */
export function releaseRunIdentity(t: { projectId: AnyPgColumn; releaseVersion: AnyPgColumn }) {
  return {
    releaseVersionUq: uniqueIndex('pipeline_runs_release_version_uq')
      .on(t.projectId, t.releaseVersion)
      .where(
        sql`release_version IS NOT NULL AND (release_released_at IS NOT NULL OR status NOT IN ('cancelled', 'failed'))`,
      ),
    releaseVersionChk: check(
      'pipeline_runs_release_version_chk',
      releaseVersionText(t.releaseVersion),
    ),
  } as const;
}
