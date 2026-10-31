// The refusal vocabulary of a message body the server cannot read as markup.

import type { RefusalStatuses } from "./refusal.js";

export const BODY_REFUSAL_CODES = ["BODY_INVALID"] as const;

export type BodyRefusalCode = (typeof BODY_REFUSAL_CODES)[number];

/** A body that is not the markup it claims is a request to fix. */
export const BODY_REFUSAL_STATUSES = {
	BODY_INVALID: 400,
} as const satisfies RefusalStatuses<BodyRefusalCode>;
