// The codes a device and the run sessions it opens are refused by, in the refusal envelope.
import type { RefusalStatuses } from "./refusal.js";

/**
 * Why `/me/pool/prepare` or `/me/pool/start` took nothing. The box reads the reason back as the
 * code with its `POOL_` prefix dropped and lower-cased (`POOL_ALREADY_HELD` → `already_held`).
 */
export const POOL_CLAIM_REFUSAL_CODES = [
	"POOL_NOT_FOUND",
	"POOL_ALREADY_HELD",
	"POOL_ISSUE_BUSY",
	"POOL_HOLD_LOST",
	"POOL_RUN_PAUSED",
	"POOL_RUN_NOT_RUNNING",
	"POOL_RUNNER_TOO_OLD",
	"POOL_RUNNER_WITHDRAWN",
	"POOL_DEVICE_DISABLED",
	"POOL_RUNNER_UNBOUND",
	"POOL_RELEASE_LABEL_MISSING",
	"POOL_NO_PROMPT",
	"POOL_POLICY_REFUSED",
	"POOL_CHECKOUT_UNBOUND",
] as const;

export type PoolClaimRefusalCode = (typeof POOL_CLAIM_REFUSAL_CODES)[number];

export const DEVICE_REFUSAL_CODES = [
	"DEVICE_REFUSED",
	"DEVICE_REVOKED",
	"RUN_SESSION_REFUSED",
	"RUNNER_NOT_ADMITTED",
	"WORKSPACE_HOLDER_REFUSED",
	"ISSUE_LEASE_AMBIGUOUS",
	"MASTER_SESSION_NOT_HELD",
	"CHECKOUT_HEAD_NOT_ASKED",
	"CHECKOUT_HEAD_MALFORMED",
	"CHECKOUT_HEAD_OTHER_REPOSITORY",
	...POOL_CLAIM_REFUSAL_CODES,
] as const;

export type DeviceRefusalCode = (typeof DEVICE_REFUSAL_CODES)[number];

export const DEVICE_REFUSAL_STATUSES = {
	MASTER_SESSION_NOT_HELD: 404,
	CHECKOUT_HEAD_NOT_ASKED: 404,
	POOL_NOT_FOUND: 404,
	POOL_ALREADY_HELD: 409,
	POOL_ISSUE_BUSY: 409,
	POOL_HOLD_LOST: 409,
	POOL_RUN_PAUSED: 409,
	POOL_RUN_NOT_RUNNING: 409,
} as const satisfies RefusalStatuses<DeviceRefusalCode>;
