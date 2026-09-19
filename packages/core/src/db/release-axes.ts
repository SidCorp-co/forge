import { sql } from 'drizzle-orm';
import { check } from 'drizzle-orm/pg-core';

export const releaseModels = ['none', 'promote', 'publish'] as const;
export type ReleaseModel = (typeof releaseModels)[number];

/** How a `promote` release moves the code. Meaningless, and refused, under any other model. */
export const releaseStrategies = ['merge-branch', 'cherry-pick', 'tag-mr'] as const;
export type ReleaseStrategy = (typeof releaseStrategies)[number];

export const bindingRoles = ['deploy', 'service'] as const;
export type BindingRole = (typeof bindingRoles)[number];

export const deployStages = ['preview', 'live'] as const;
export type DeployStage = (typeof deployStages)[number];

const RELEASE_MODEL_CHK = sql`release_model IN ('none', 'promote', 'publish')`;

const LIVE_BRANCH_CHK = sql`release_model <> 'promote' OR live_branch IS NOT NULL`;

const RELEASE_STRATEGY_CHK = sql`(release_model = 'promote') = (release_strategy IS NOT NULL) AND (release_strategy IS NULL OR release_strategy IN ('merge-branch', 'cherry-pick', 'tag-mr'))`;

const BINDING_ROLE_CHK = sql`role IN ('deploy', 'service')`;

const ROLE_STAGES_CHK = sql`(role = 'service' AND cardinality(stages) = 0) OR (role = 'deploy' AND array_ndims(stages) = 1 AND cardinality(stages) BETWEEN 1 AND 2 AND stages <@ ARRAY['preview', 'live'] AND (cardinality(stages) = 1 OR stages[1] <> stages[2]))`;

export const SERVICE_ROLE_PRED = sql`role = 'service'`;

/** Spread into `projects`' extras in `schema.ts`; the constraint names are what Postgres reports. */
export const releaseProjectChecks = {
  releaseModelChk: check('projects_release_model_chk', RELEASE_MODEL_CHK),
  liveBranchChk: check('projects_live_branch_chk', LIVE_BRANCH_CHK),
  releaseStrategyChk: check('projects_release_strategy_chk', RELEASE_STRATEGY_CHK),
} as const;

export const agentAccessValues = ['none', 'all'] as const;
export type AgentAccess = (typeof agentAccessValues)[number];

const AGENT_ACCESS_CHK = sql`agent_access IN ('none', 'all')`;

/** Spread into `integrationBindings`' extras in `schema.ts`. */
export const bindingShapeChecks = {
  roleChk: check('integration_bindings_role_chk', BINDING_ROLE_CHK),
  roleStagesChk: check('integration_bindings_role_stages_chk', ROLE_STAGES_CHK),
  agentAccessChk: check('integration_bindings_agent_access_chk', AGENT_ACCESS_CHK),
} as const;
