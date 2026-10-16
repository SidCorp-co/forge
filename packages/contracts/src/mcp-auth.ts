// MCP OAuth: an MCP client (Claude Code) signs in to core's `/mcp` through the browser instead of
// carrying a pasted token. Core is both the authorization server and the protected resource; the
// access token it issues is a personal access token that lives an hour, and the refresh token
// rotates on every use. The person picks the projects and the permissions on the consent page, the
// same choice the token form offers.

import type { RefusalStatuses } from "./refusal.js";

/** How long an access token lives: an hour, then the client refreshes. */
export const MCP_OAUTH_ACCESS_TTL_SECONDS = 60 * 60;
/** How long a refresh token lives unused; every refresh issues a new one with a fresh window. */
export const MCP_OAUTH_REFRESH_TTL_DAYS = 30;
/** How long a code waits for the client to redeem it. */
export const MCP_OAUTH_CODE_TTL_SECONDS = 5 * 60;

/** The scopes a grant may hold: the same two a personal access token carries. */
export const MCP_OAUTH_SCOPES = ["read", "write"] as const;
export type McpOAuthScope = (typeof MCP_OAUTH_SCOPES)[number];

/**
 * A refresh token or an authorization code: the prefix and 43 base64url characters (256 random
 * bits), stored only as its SHA-256. The prefix is what lets the log scrubber
 * (`@forge/observability:scrubLogText`) find one anywhere.
 */
export const MCP_OAUTH_REFRESH_PREFIX = "forge_mcp_rt_";
export const MCP_OAUTH_CODE_PREFIX = "forge_mcp_code_";

/** Where the consent page lives, under the web origin. */
export const MCP_OAUTH_CONSENT_PATH = "/oauth/authorize";

/** What the consent page reads before it asks: who is asking, and where the answer goes. */
export interface McpConsentView {
	client: {
		id: string;
		name: string;
		/** The host the browser is sent back to; a loopback host is the person's own machine. */
		redirectHost: string;
		registeredAt: string;
	};
	/** The scopes the client asked for; a grant holds no more than these. */
	requestedScopes: McpOAuthScope[];
	/** The permission menu, as the token form reads it from `GET /api/pat`. */
	menu: {
		permissions: string[];
		accountOnly: string[];
		explicit: string[];
		full: string;
	};
}

/**
 * The person's answer (`POST /api/mcp-auth/authorize`): the client's OAuth parameters as it sent
 * them, under their OAuth names, and allow with a reach, or deny. Either way core answers where to
 * send the browser next.
 */
export interface McpConsentDecision {
	client_id: string;
	redirect_uri: string;
	response_type: "code";
	code_challenge: string;
	code_challenge_method: "S256";
	scope?: string | undefined;
	resource?: string | undefined;
	state?: string | undefined;
	decision: "allow" | "deny";
	/** The projects the grant reaches; null reaches every project the person can see. */
	project_ids?: string[] | null | undefined;
	permissions?: string[] | undefined;
	scopes?: McpOAuthScope[] | undefined;
}

export interface McpConsentAnswer {
	/** The client's redirect URI carrying `code` (or `error=access_denied`) and `state`. */
	redirectTo: string;
}

export const MCP_AUTH_REFUSAL_CODES = [
	"MCP_AUTH_REFUSED",
	/** No client registered under this id. */
	"MCP_AUTH_CLIENT_UNKNOWN",
	/** The redirect URI is not one the client registered. */
	"MCP_AUTH_REDIRECT_UNREGISTERED",
	/** The request names a resource other than this core's `/mcp`. */
	"MCP_AUTH_RESOURCE_FOREIGN",
	/** A scope outside `read` and `write`, or more than the client asked for. */
	"MCP_AUTH_SCOPE_INVALID",
] as const;

export type McpAuthRefusalCode = (typeof MCP_AUTH_REFUSAL_CODES)[number];

export const MCP_AUTH_REFUSAL_STATUSES = {
	MCP_AUTH_CLIENT_UNKNOWN: 404,
} as const satisfies RefusalStatuses<McpAuthRefusalCode>;
