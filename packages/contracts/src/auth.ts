// The refusal vocabulary of sign-in, registration, preferences and a chat turn's authority.
import type { RefusalStatuses } from "./refusal.js";

export const AUTH_REFUSAL_CODES = [
	"AUTH_REFUSED",
	"AGENT_CANNOT_LOGIN",
	"EMAIL_ALREADY_REGISTERED",
	"PREFERENCE_CHANGE_SUPERSEDED",
] as const;

export type AuthRefusalCode = (typeof AUTH_REFUSAL_CODES)[number];

/** Why a turn will not act as the person who spoke. */
export const TURN_AUTHORITY_REFUSAL_CODES = [
	"TURN_NO_ROLE",
	"TURN_TOKEN_NOT_LIVE",
	"TURN_TOKEN_FENCED",
	"TURN_GRANT_EMPTY",
	"TURN_DEVICE_NO_ROLE",
	"TURN_DEVICE_OUTRANKED",
	"TURN_ORIGIN_REFUSED",
] as const;

export type TurnAuthorityRefusalCode = (typeof TURN_AUTHORITY_REFUSAL_CODES)[number];
export const AUTH_REFUSAL_STATUSES = {
	PREFERENCE_CHANGE_SUPERSEDED: 409,
	TURN_NO_ROLE: 403,
	TURN_DEVICE_NO_ROLE: 403,
	TURN_ORIGIN_REFUSED: 403,
} as const satisfies RefusalStatuses<AuthRefusalCode | TurnAuthorityRefusalCode>;
