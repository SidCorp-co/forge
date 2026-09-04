// Response schema for `GET /api/pipeline/registry`. The runtime literal +
// derived constants live in `@forge/core/src/pipeline/registry.ts`; this
// file is the client-facing Zod contract.
//
// Enum tuples are hardcoded locally rather than imported from core because
// `@forge/core/public` has side effects at module load (env validation in
// `src/config/env.ts`). Importing it at runtime in a browser or test
// without `DATABASE_URL`/`JWT_SECRET` set would throw. A parity test in
// `packages/core/src/pipeline/registry.test.ts` keeps these tuples in sync
// with `core/db/schema.ts` and `core/pipeline/pipeline-config-schema.ts`.

import { z } from "zod";

export const REGISTRY_ISSUE_STATUSES = [
	"open",
	"confirmed",
	"clarified",
	"waiting",
	"approved",
	"in_progress",
	"developed",
	"testing",
	"tested",
	"released",
	"closed",
	"reopen",
	"on_hold",
	"needs_info",
	"draft",
	// cm:edge contract -> packages/core/src/db/schema.ts#issueStatuses — closed-without-stamping; a client union missing it renders an unknown status on a terminal issue
	"dropped",
] as const;

export const REGISTRY_JOB_TYPES = [
	"triage",
	"clarify",
	"plan",
	"code",
	"review",
	"test",
	"staging",
	"release",
	"fix",
	"custom",
	"pm",
	// ISS-455 — skill smoke-verify canary (issue-less, one-shot 'system' run).
	"smoke",
	"release_batch",
	// cm:why ISS-801 — Update Pipeline stage ② (Reconcile): Master agent + verifier jobs
	"reconcile",
	"verify_skill",
	// cm:edge contract -> packages/core/src/db/schema.ts#jobTypes — the autonomous driver's single job type; a client union missing it renders an unknown badge instead of failing
	"drive",
] as const;

export const REGISTRY_RUNNER_TYPES = ["claude-code"] as const;

// cm:edge contract -> packages/core/src/db/schema.ts#issuePriorities — client-facing mirror of the
//   issue/run enums, so web-v2/dev derive their unions from here instead of hand-copying the DB enum
// cm:edge contract -> packages/core/src/pipeline/registry.test.ts#REGISTRY_ISSUE_PRIORITIES — the
//   parity suite that fails when the two sides drift; adding a value here without it there is silent
export const REGISTRY_ISSUE_PRIORITIES = [
	"critical",
	"high",
	"medium",
	"low",
	"none",
] as const;

export const REGISTRY_ISSUE_COMPLEXITIES = ["xs", "s", "m", "l", "xl"] as const;

export const REGISTRY_PIPELINE_RUN_STATUSES = [
	"running",
	"paused",
	"completed",
	"failed",
	"cancelled",
] as const;

export const REGISTRY_PIPELINE_RUN_KINDS = [
	"issue",
	"pm",
	"interactive",
	"system",
] as const;

export const REGISTRY_STEP_TOGGLE_KEYS = [
	"autoTriage",
	"autoClarify",
	"autoPlan",
	"autoCode",
	"autoReview",
	"autoTest",
	"autoFix",
	"autoRelease",
] as const;

export const pipelineStepSchema = z.object({
	status: z.enum(REGISTRY_ISSUE_STATUSES),
	jobType: z.enum(REGISTRY_JOB_TYPES),
	toggle: z.enum(REGISTRY_STEP_TOGGLE_KEYS),
	skillName: z.string().min(1),
	/** In-flight status the step's agent flips to at start (sparse; registry v3). */
	workingStatus: z.enum(REGISTRY_ISSUE_STATUSES).nullable(),
});
export type PipelineStep = z.infer<typeof pipelineStepSchema>;

export const pipelineRegistryResponseSchema = z.object({
	version: z.number().int().positive(),
	steps: z.array(pipelineStepSchema),
	runnerCapabilities: z.record(
		z.enum(REGISTRY_RUNNER_TYPES),
		z.array(z.enum(REGISTRY_JOB_TYPES)),
	),
	manualOnlyJobTypes: z.array(z.enum(REGISTRY_JOB_TYPES)),
});
export type PipelineRegistryResponse = z.infer<
	typeof pipelineRegistryResponseSchema
>;
