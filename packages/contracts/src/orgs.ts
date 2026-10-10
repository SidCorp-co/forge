// The refusal vocabulary of organizations, their members and agent accounts.

import type { RefusalStatuses } from "./refusal.js";

export const ORG_REFUSAL_CODES = [
	"ORG_REFUSED",
	"SLUG_TAKEN",
	"PERSONAL_ORG_IMMUTABLE",
	"ORG_NOT_EMPTY",
	"ALREADY_MEMBER",
	"LAST_OWNER",
	"OWNER_NOT_INVITABLE",
	"INVITATION_EMAIL_MISMATCH",
	"AGENT_HANDLE_TAKEN",
	"AGENT_IS_A_PROJECT_HANDLE",
	"MAIL_NOT_CONFIGURED",
	"INVITATION_MAIL_FAILED",
] as const;

export type OrgRefusalCode = (typeof ORG_REFUSAL_CODES)[number];

/** An invitation this instance cannot mail waits on an operator, not on the caller (REQ-27 BC-3). */
export const ORG_REFUSAL_STATUSES = {
	MAIL_NOT_CONFIGURED: 503,
	INVITATION_MAIL_FAILED: 503,
} as const satisfies RefusalStatuses<OrgRefusalCode>;
