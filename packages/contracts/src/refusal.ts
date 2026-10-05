// The one refusal body, at REST and MCP alike (docs/conventions/domain-entities.md).
export type Refusal = {
	code: string;
	path: string;
	detail: string;
};

/**
 * What the client should do picks the status: fix the request (400), stop asking (403), the row is
 * not there for it (404), re-read and retry (409), change what the rule names (422), or wait for an
 * operator to configure what this instance lacks (503).
 */
export const REFUSAL_STATUSES = [400, 403, 404, 409, 422, 503] as const;
export type RefusalStatus = (typeof REFUSAL_STATUSES)[number];

/**
 * A module's codes that answer something other than 422, declared beside its code array and
 * collected by `refusal-statuses.ts:REFUSAL_STATUS`. A code ending `_FORBIDDEN` answers 403 without
 * being listed.
 */
export type RefusalStatuses<C extends string> = Readonly<
	Partial<Record<C, Exclude<RefusalStatus, 422>>>
>;

/** Most relevant first: a refusal the caller cannot fix by editing the body leads. */
export const REFUSAL_STATUS_ORDER: readonly RefusalStatus[] = [
	503, 403, 404, 400, 409, 422,
];

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** RFC 9457 `type`: a URI naming the code. */
export const refusalType = (code: string) => `urn:forge:refusal:${code}`;

/** RFC 9457 `title`, fixed per code: `ISSUE_LEASE_HELD` reads `Issue lease held`. */
export function refusalTitle(code: string): string {
	const words = code.toLowerCase().split("_").filter(Boolean).join(" ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** RFC 9457 problem details beside the envelope Forge clients branch on (`error.code`). */
export type RefusalEnvelope = {
	type: string;
	title: string;
	status: RefusalStatus;
	detail: string;
	error: {
		code: string;
		message: string;
		refusals: Refusal[];
	};
};
