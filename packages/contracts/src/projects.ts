// The refusal vocabulary of projects, their members, invitations and issue prefixes.

export const PROJECT_REFUSAL_CODES = [
	"PROJECT_REFUSED",
	"SLUG_TAKEN",
	"ISSUE_PREFIX_TAKEN",
	"NOT_ORG_MEMBER",
	"ALREADY_MEMBER",
	"INVITATION_EMAIL_MISMATCH",
] as const;

export type ProjectRefusalCode = (typeof PROJECT_REFUSAL_CODES)[number];
