// The refusal vocabulary of an invitation that can no longer be taken, project and organisation alike.

import type { RefusalStatuses } from "./refusal.js";

export const INVITATION_REFUSAL_CODES = ["ALREADY_ACCEPTED", "EXPIRED_TOKEN"] as const;

export type InvitationRefusalCode = (typeof INVITATION_REFUSAL_CODES)[number];

/** An accepted invitation is a state to re-read; an expired one is the rule's own 422. */
export const INVITATION_REFUSAL_STATUSES = {
	ALREADY_ACCEPTED: 409,
} as const satisfies RefusalStatuses<InvitationRefusalCode>;
