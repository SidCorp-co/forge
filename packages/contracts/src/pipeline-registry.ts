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

// ISS-917 — statuses a project MAY admit to its master's pool backlog. Core
// derives this by subtracting `AUTONOMOUS_DRIVER_STATUSES` from `issueStatuses`
// (a driver status already carries a run and a job, so a backlog row at one
// could never be promoted). Hardcoded here for the same reason the tuple above
// is, and held to core by the same parity test.
// cm:edge contract -> packages/core/src/pipeline/autonomous-mode.ts#BACKLOG_ADMISSIBLE_STATUSES — parity asserted in packages/core/src/pipeline/registry.test.ts; a status that becomes a driver status must leave this tuple in the same change or the settings screen offers a value the config schema rejects
export const REGISTRY_BACKLOG_ADMISSIBLE_STATUSES = [
	"confirmed",
	"clarified",
	"waiting",
	"approved",
	"developed",
	"testing",
	"tested",
	"released",
	"reopen",
	"on_hold",
	"draft",
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

// cm:guard `steps`, `manualOnlyJobTypes` and the eight `auto*` toggle keys left with the staged lane (ISS-895) and must not come back here alone: this schema is what a client PARSES, so re-adding a required key the server no longer sends makes every registry read throw. The nine staged job types stay in REGISTRY_JOB_TYPES because ~30k historical `jobs` rows hold them and a client must still render one.
export const pipelineRegistryResponseSchema = z.object({
	version: z.number().int().positive(),
	runnerCapabilities: z.record(
		z.enum(REGISTRY_RUNNER_TYPES),
		z.array(z.enum(REGISTRY_JOB_TYPES)),
	),
});
export type PipelineRegistryResponse = z.infer<
	typeof pipelineRegistryResponseSchema
>;
