// The refusal vocabulary of projects, their members, invitations and issue prefixes.

import type { RefusalStatuses } from "./refusal.js";

export const PROJECT_REFUSAL_CODES = [
	"PROJECT_REFUSED",
	"SLUG_TAKEN",
	"ISSUE_PREFIX_TAKEN",
	"NOT_ORG_MEMBER",
	"ALREADY_MEMBER",
	"INVITATION_EMAIL_MISMATCH",
	"PROJECT_SLUG_UNKNOWN",
	"PROJECT_SLUG_RESERVED",
	"MAIL_NOT_CONFIGURED",
	"INVITATION_MAIL_FAILED",
] as const;

export type ProjectRefusalCode = (typeof PROJECT_REFUSAL_CODES)[number];

/** A route addressed by a slug no project carries is not found, not malformed. */
export const PROJECT_REFUSAL_STATUSES = {
	PROJECT_SLUG_UNKNOWN: 404,
	MAIL_NOT_CONFIGURED: 503,
	INVITATION_MAIL_FAILED: 503,
} as const satisfies RefusalStatuses<ProjectRefusalCode>;
