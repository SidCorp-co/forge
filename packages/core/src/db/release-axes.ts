/**
 * The three declared axes of a release, as plain values: what a release MEANS on a project, how a
 * promoting one moves its code, what a binding is FOR, and which stages a deploy binding serves.
 *
 * Their own module rather than `schema.ts` because they are the vocabulary, not the tables — read by
 * the zod request schemas, the contracts package, the prompt renderer and the web screens, none of
 * which wants a drizzle table. `schema.ts` re-exports every name, so no importer had to move.
 */

import { sql } from 'drizzle-orm';
import { check } from 'drizzle-orm/pg-core';

/**
 * What a release MEANS on this project — declared on the project, never derived.
 *
 * `none` — there is no release step and `closed` means what it says. True of 25 of the 32 active
 * projects, and the state the four "release strategies" an earlier issue listed had no way to say.
 * `promote` — the release moves CODE from `baseBranch` to `liveBranch`, by `releaseStrategy`.
 * `publish` — the ref does not change; the release is an ACT on a live binding (publish a theme,
 * deploy a build).
 */
export const releaseModels = ['none', 'promote', 'publish'] as const;
export type ReleaseModel = (typeof releaseModels)[number];

/** How a `promote` release moves the code. Meaningless, and refused, under any other model. */
export const releaseStrategies = ['merge-branch', 'cherry-pick', 'tag-mr'] as const;
export type ReleaseStrategy = (typeof releaseStrategies)[number];

/**
 * What a binding is FOR — on the binding, never on the provider.
 *
 * `deploy` — Forge can push code or content to it, so it serves one or both stages.
 * `service` — a project-wide facility with no stage at all: an error tracker, a chat room, a repo
 * host, a collection runner. A `service` binding carries NO stage, which is what deletes the seven
 * `default('prod')` fillers rather than renaming them.
 */
export const bindingRoles = ['deploy', 'service'] as const;
export type BindingRole = (typeof bindingRoles)[number];

/**
 * The two environments, named for who is looking at them rather than for a branch.
 *
 * `preview` — deployed so people can see it before it counts. `live` — real users are on it.
 *
 * Chosen against the fleet: `staging`, `stg` and `release/stg` are BRANCH names on eight projects and
 * sidpeak carried `baseBranch: staging` beside `environment: staging`, one word with two meanings in
 * one project; and `prod` lied where it mattered most, since a `prod` binding sat on a project whose
 * production branch was called `release/stg`. No project in the fleet names a branch `preview` or
 * `live`, and neither word presumes a git repository, so a storefront can wear them.
 */
export const deployStages = ['preview', 'live'] as const;
export type DeployStage = (typeof deployStages)[number];

/**
 * The same four vocabularies as CHECK predicates, for the tables that store them.
 *
 * They live beside the values rather than inline in `schema.ts` because this is where a reader
 * changing a vocabulary looks, and a word added to one of the arrays above without its predicate
 * below is representable in TypeScript and refused by Postgres.
 */
const RELEASE_MODEL_CHK = sql`release_model IN ('none', 'promote', 'publish')`;

const LIVE_BRANCH_CHK = sql`release_model <> 'promote' OR live_branch IS NOT NULL`;

const RELEASE_STRATEGY_CHK = sql`(release_model = 'promote') = (release_strategy IS NOT NULL) AND (release_strategy IS NULL OR release_strategy IN ('merge-branch', 'cherry-pick', 'tag-mr'))`;

const BINDING_ROLE_CHK = sql`role IN ('deploy', 'service')`;

const ROLE_STAGES_CHK = sql`(role = 'service' AND cardinality(stages) = 0) OR (role = 'deploy' AND array_ndims(stages) = 1 AND cardinality(stages) BETWEEN 1 AND 2 AND stages <@ ARRAY['preview', 'live'] AND (cardinality(stages) = 1 OR stages[1] <> stages[2]))`;

/** The `service` half of `role`, as the partial-index predicate `integration_bindings_service_uq` is
 *  built on — the same words as `BINDING_ROLE_CHK`'s second member, and they must stay the same. */
export const SERVICE_ROLE_PRED = sql`role = 'service'`;

/** Spread into `projects`' extras in `schema.ts`; the constraint names are what Postgres reports. */
export const releaseProjectChecks = {
  releaseModelChk: check('projects_release_model_chk', RELEASE_MODEL_CHK),
  liveBranchChk: check('projects_live_branch_chk', LIVE_BRANCH_CHK),
  releaseStrategyChk: check('projects_release_strategy_chk', RELEASE_STRATEGY_CHK),
} as const;

/** Spread into `integrationBindings`' extras in `schema.ts`. */
export const bindingShapeChecks = {
  roleChk: check('integration_bindings_role_chk', BINDING_ROLE_CHK),
  roleStagesChk: check('integration_bindings_role_stages_chk', ROLE_STAGES_CHK),
} as const;
