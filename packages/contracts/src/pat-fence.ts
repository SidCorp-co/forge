// cm:why one declaration of the token fence edit (ISS-92): core's table CHECK, the REST route and its
// refusals read these, so a fence the route accepts is one the table can hold and one a client can name

import { z } from "zod";

const PAT_FENCE_MAX_PROJECTS = 50;
export const PAT_FENCE_REASON_MAX = 500;

export const PAT_FENCE_REFUSAL_CODES = [
	"PAT_FENCE_BY_TOKEN_FORBIDDEN",
	"PAT_FENCE_TOKEN_REVOKED",
	"PAT_FENCE_TOKEN_EXPIRED",
	"PAT_FENCE_CORE_MINTED",
	"PAT_FENCE_PROJECT_NOT_REACHABLE",
	"PAT_FENCE_ACCOUNT_PERMISSION",
	"PAT_FENCE_UNCHANGED",
] as const;
export type PatFenceRefusalCode = (typeof PAT_FENCE_REFUSAL_CODES)[number];

export const SET_PAT_FENCE_SHAPE =
	"{ projectIds: uuid[] (1..50, distinct) | boundProjectId: uuid — exactly one, reason: string (1..500) }";

export const setPatFenceRequestSchema = z
	.strictObject({
		projectIds: z.array(z.uuid()).min(1).max(PAT_FENCE_MAX_PROJECTS).optional(),
		boundProjectId: z.uuid().optional(),
		reason: z.string().trim().min(1).max(PAT_FENCE_REASON_MAX),
	})
	.refine(
		(b) => (b.projectIds === undefined) !== (b.boundProjectId === undefined),
		{
			message: "name exactly one of projectIds or boundProjectId",
			path: ["projectIds"],
		},
	)
	.refine(
		(b) => !b.projectIds || new Set(b.projectIds).size === b.projectIds.length,
		{
			message: "projectIds names a project twice",
			path: ["projectIds"],
		},
	);
export type PatFence = {
	projectIds: string[] | null;
	boundProjectId: string | null;
};

export type PatFenceChangeView = {
	id: string;
	tokenId: string;
	changedBy: string;
	previous: PatFence;
	fence: PatFence;
	reason: string;
	changedAt: string;
};
