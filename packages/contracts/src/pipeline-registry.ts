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
	"awaiting_release",
	"releasing",
	"closed",
	"reopen",
	"on_hold",
	"needs_info",
	"draft",
	"dropped",
] as const;

export const REGISTRY_BACKLOG_ADMISSIBLE_STATUSES = [
	"confirmed",
	"clarified",
	"waiting",
	"approved",
	"developed",
	"testing",
	"tested",
	"awaiting_release",
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
	"smoke",
	"release_batch",
	"reconcile",
	"verify_skill",
	"drive",
] as const;

export const REGISTRY_RUNNER_TYPES = ["claude-code"] as const;

//   issue/run enums, so web-v2/dev derive their unions from here instead of hand-copying the DB enum
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

export const pipelineRegistryResponseSchema = z.object({
	version: z.number().int().positive(),
	runnerCapabilities: z.record(
		z.enum(REGISTRY_RUNNER_TYPES),
		z.array(z.enum(REGISTRY_JOB_TYPES)),
	),
	statusExits: z
		.record(
			z.enum(REGISTRY_ISSUE_STATUSES),
			z.array(z.enum(REGISTRY_ISSUE_STATUSES)),
		)
		.optional(),
});

export type StatusExits = Partial<
	Record<
		(typeof REGISTRY_ISSUE_STATUSES)[number],
		(typeof REGISTRY_ISSUE_STATUSES)[number][]
	>
>;
export type PipelineRegistryResponse = z.infer<
	typeof pipelineRegistryResponseSchema
>;
