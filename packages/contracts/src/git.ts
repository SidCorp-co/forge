import type { RefusalStatuses } from "./refusal.js";

// Refusal codes the git door answers in the one envelope (docs/patterns/core-module.md).
export const GIT_REFUSAL_CODES = [
	"GIT_REFUSED",
	"GIT_CONNECTION_INACTIVE",
	// a host whose git goes through Forge's relay, asked for directly: its token is never handed out
	"GIT_THROUGH_FORGE",
	// the relay opened without a live ticket: answered as git's own 401 challenge, so git asks its
	// credential helper for one, never in the envelope (whose statuses hold no 401)
	"GIT_RELAY_UNAUTHENTICATED",
	// a live ticket for a repository its device no longer runs, or a binding no longer active
	"GIT_RELAY_FORBIDDEN",
	// a relay path that is not one of git's smart-HTTP requests
	"GIT_RELAY_PATH_UNKNOWN",
	// core knows no public origin to relay through, so no relay URL can be handed out
	"GIT_RELAY_UNAVAILABLE",
	// the host refused the connection's own credential on the relayed request: an operator reconnects it
	"GIT_RELAY_UPSTREAM_REFUSED",
] as const;
export type GitRefusalCode = (typeof GIT_REFUSAL_CODES)[number];

export const GIT_REFUSAL_STATUSES = {
	GIT_THROUGH_FORGE: 409,
	GIT_RELAY_FORBIDDEN: 403,
	GIT_RELAY_PATH_UNKNOWN: 404,
	GIT_RELAY_UNAVAILABLE: 503,
	GIT_RELAY_UPSTREAM_REFUSED: 503,
} as const satisfies RefusalStatuses<GitRefusalCode>;
