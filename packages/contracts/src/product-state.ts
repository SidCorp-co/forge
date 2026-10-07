// A person's product state: small facts about what one person has seen of the product, held per
// person on the server so a second browser reads the same (`user_product_state`). The key namespace
// is closed: What's new's seen mark, and one key per product tour. A key outside it is refused by
// name, never stored as free text.

import { z } from "zod";
import type { RefusalStatuses } from "./refusal.js";

/** When the person last opened What's new: entries released after it are unread. */
export const WHATS_NEW_SEEN_KEY = "whats_new_seen_at" as const;

/** A tour's key is this prefix and the tour's id: `tour:release-what-changes`. */
export const TOUR_KEY_PREFIX = "tour:" as const;

export const TOUR_ID_MAX = 64;
const TOUR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ProductStateKey = typeof WHATS_NEW_SEEN_KEY | `${typeof TOUR_KEY_PREFIX}${string}`;

export const PRODUCT_STATE_KEY_SHAPE = `\`${WHATS_NEW_SEEN_KEY}\`, or \`${TOUR_KEY_PREFIX}<id>\` where <id> is lower-case kebab-case of at most ${TOUR_ID_MAX} characters`;

/** Which family a key belongs to, or null for a key outside the closed namespace. */
export function productStateKeyKind(key: string): "whats_new_seen" | "tour" | null {
	if (key === WHATS_NEW_SEEN_KEY) return "whats_new_seen";
	if (!key.startsWith(TOUR_KEY_PREFIX)) return null;
	const id = key.slice(TOUR_KEY_PREFIX.length);
	return id.length > 0 && id.length <= TOUR_ID_MAX && TOUR_ID.test(id) ? "tour" : null;
}

export const productStateKeySchema = z
	.string()
	.refine((key) => productStateKeyKind(key) !== null, {
		error: (issue) =>
			`${JSON.stringify(issue.input)} is not a product state key: it is ${PRODUCT_STATE_KEY_SHAPE}`,
	});

/** How far ahead of the server's clock a seen mark may be, for a browser clock running fast. */
export const SEEN_AT_SKEW_MS = 5 * 60 * 1000;

/** `whats_new_seen_at`: the moment the person opened What's new. */
export const whatsNewSeenValueSchema = z.strictObject({
	at: z.iso.datetime({ offset: true, error: "at is an ISO 8601 date-time" }),
});
export type WhatsNewSeenValue = z.infer<typeof whatsNewSeenValueSchema>;

export const TOUR_OUTCOMES = ["completed", "dismissed"] as const;
export type TourOutcome = (typeof TOUR_OUTCOMES)[number];

/** `tour:<id>`: how the person last left the tour, at which revision, and the step a dismissal left at. */
export const tourStateValueSchema = z.strictObject({
	revision: z.number().int().positive(),
	outcome: z.enum(TOUR_OUTCOMES),
	step: z.number().int().min(1).max(4).optional(),
	at: z.iso.datetime({ offset: true, error: "at is an ISO 8601 date-time" }),
});
export type TourStateValue = z.infer<typeof tourStateValueSchema>;

export const PRODUCT_STATE_VALUE_SHAPES = {
	whats_new_seen: "{ value: { at: ISO 8601 date-time, no later than now } }",
	tour: "{ value: { revision: positive integer, outcome: 'completed' | 'dismissed', step?: 1-4, at: ISO 8601 date-time } }",
} as const;

export const putProductStateRequestSchema = z.strictObject({ value: z.unknown() });

export interface ProductStateView {
	key: ProductStateKey;
	value: WhatsNewSeenValue | TourStateValue | null;
	updatedAt: string | null;
}

export interface ProductStateListResponse {
	items: ProductStateView[];
}

const PRODUCT_STATE_REFUSAL_CODES = [
	"PRODUCT_STATE_KEY_UNKNOWN",
	"PRODUCT_STATE_VALUE_INVALID",
	"PRODUCT_STATE_REFUSED",
] as const;
export type ProductStateRefusalCode = (typeof PRODUCT_STATE_REFUSAL_CODES)[number];
export const PRODUCT_STATE_REFUSAL_STATUSES = {
	PRODUCT_STATE_KEY_UNKNOWN: 400,
	PRODUCT_STATE_VALUE_INVALID: 400,
} as const satisfies RefusalStatuses<ProductStateRefusalCode>;
