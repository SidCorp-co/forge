// The one refusal envelope a domain write answers with, at the REST door and the MCP door alike
// (docs/conventions/domain-entities.md). Type-only: core builds it in `packages/core/src/lib/refusal.ts`.

/** One named refusal: what was refused, where in the input (a JSON pointer, '' for the whole act), and why. */
export type Refusal = {
	code: string;
	path: string;
	detail: string;
};

/**
 * The body of every refusal. `code` is the single code when every refusal shares one, else the
 * domain's fallback (`SUGGESTION_REFUSED`, `CONFIG_REFUSED`, …); `refusals` is never empty.
 */
export type RefusalEnvelope = {
	error: {
		code: string;
		message: string;
		refusals: Refusal[];
	};
};

/** 403: who may act. 409: the head or row moved since it was read. 422: every other rule. */
export type RefusalStatus = 403 | 409 | 422;
