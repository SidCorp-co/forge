// The refusal vocabulary of organizations, their members and agent accounts.

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
] as const;

export type OrgRefusalCode = (typeof ORG_REFUSAL_CODES)[number];
