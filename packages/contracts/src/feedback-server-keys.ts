// A product server's key to file Feedback into its one Forge project (ISS-922). A holder of
// `project.admin` mints it, person or agent; the secret is shown once and kept as its SHA-256. The key
// admits `POST /api/projects/:id/feedback` on that project, rate-limited per key, and every item it
// files names the product as its reporter. It reads back where an item its product filed stands
// (`GET /api/projects/:id/feedback/:fb`, ISS-1287), with a declined item's reason (ISS-1412), and
// nothing else.

import { z } from "zod";
import { FEEDBACK_PHASES, FEEDBACK_ROW_CHIPS } from "./feedback.js";
import type { RefusalStatuses } from "./refusal.js";

/** The secret: this prefix and 43 base64url characters (256 random bits). */
export const FEEDBACK_SERVER_KEY_PREFIX = "fsk_";
export const FEEDBACK_SERVER_KEY_PATTERN = /^fsk_[A-Za-z0-9_-]{43}$/;
/** How many leading characters of the secret the listing shows, so keys can be told apart. */
export const FEEDBACK_SERVER_KEY_SHOWN_CHARS = 12;

/** Filings one key may make in one hour; the next is refused `FEEDBACK_SERVER_KEY_RATE_LIMITED`. */
export const FEEDBACK_SERVER_KEY_FILINGS_PER_HOUR = 30;

/** Whether text is presented as a server key: the door that admits one, and every other door that refuses it, read this. */
export const isFeedbackServerKeyLike = (token: string) =>
	token.startsWith(FEEDBACK_SERVER_KEY_PREFIX);

export const mintFeedbackServerKeyRequestSchema = z.strictObject({
	/** The product the key speaks for, the reporter every filing names. */
	product: z.string().trim().min(1).max(64),
	expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type MintFeedbackServerKeyRequest = z.infer<
	typeof mintFeedbackServerKeyRequestSchema
>;
export const MINT_FEEDBACK_SERVER_KEY_SHAPE =
	"{ product: 1-64 characters, the product the key speaks for, expiresAt?: an ISO date-time in the future }";

export interface FeedbackServerKeyView {
	id: string;
	product: string;
	/** The secret's first characters; never the secret. */
	prefix: string;
	createdBy: { id: string; name: string | null } | null;
	createdAt: string;
	lastUsedAt: string | null;
	expiresAt: string | null;
	revokedAt: string | null;
}

/** `POST …/feedback/server-keys`: the key, and its secret, shown this once. */
export interface FeedbackServerKeyMintResponse {
	key: FeedbackServerKeyView;
	secret: string;
}

/** `GET …/feedback/server-keys`: every key of the project, newest first, revoked ones included. */
export interface FeedbackServerKeyListResponse {
	keys: FeedbackServerKeyView[];
}

/** `DELETE …/feedback/server-keys/:keyId`: the key as it now reads, revoked. */
export interface FeedbackServerKeyRevokeResponse {
	key: FeedbackServerKeyView;
}

/**
 * `POST …/feedback` under a server key: the item's key and whether this call filed it, and the
 * reporter it was recorded as.
 */
export interface FeedbackServerKeyFiledResponse {
	feedback: { key: string; created: boolean };
	reporter: { kind: "product"; product: string };
}

/**
 * `GET …/feedback/:fb` under a server key, on an item its product filed: where it stands, read by the
 * reader the project's own feedback page reads it with: its phase and the one word its row's chip says,
 * and on a declined item the reason its decline wrote for the reporter (ISS-1412). Nothing else of the
 * item: no other decision, note, message or who decided.
 */
export const feedbackServerKeyReadResponseSchema = z.strictObject({
	feedback: z.strictObject({
		key: z.string().describe("The item's key, FB-n."),
		phase: z.enum(FEEDBACK_PHASES),
		chip: z.enum(FEEDBACK_ROW_CHIPS),
		declineReason: z
			.string()
			.nullable()
			.describe(
				"Where phase is declined, the reason the decline wrote for its reporter (a duplicate reads its original's); null in every other phase, and where the project's data policy (no_egress) keeps decision reasons from every agent. Read declineReasonWithheld to tell the two nulls apart.",
			),
		declineReasonWithheld: z
			.boolean()
			.describe(
				"True where phase is declined and the project's data policy (no_egress) keeps the reason from this key, so declineReason null is withheld and not absent; false in every other case.",
			),
	}),
});
export type FeedbackServerKeyReadResponse = z.infer<
	typeof feedbackServerKeyReadResponseSchema
>;

export const FEEDBACK_SERVER_KEY_REFUSAL_CODES = [
	"FEEDBACK_SERVER_KEY_REFUSED",
	"FEEDBACK_SERVER_KEY_SCOPE",
	"FEEDBACK_SERVER_KEY_NOT_FOUND",
	"FEEDBACK_SERVER_KEY_EXPIRY_PAST",
	"FEEDBACK_SERVER_KEY_REVOKED_ALREADY",
] as const;
export type FeedbackServerKeyRefusalCode =
	(typeof FEEDBACK_SERVER_KEY_REFUSAL_CODES)[number];

export const FEEDBACK_SERVER_KEY_REFUSAL_STATUSES = {
	FEEDBACK_SERVER_KEY_SCOPE: 403,
	FEEDBACK_SERVER_KEY_NOT_FOUND: 404,
	FEEDBACK_SERVER_KEY_REVOKED_ALREADY: 409,
} as const satisfies RefusalStatuses<FeedbackServerKeyRefusalCode>;

/**
 * The answers a server key gets at the door that are not refusals of a request body: an unknown,
 * revoked or expired key (401), a read of an item another reporter filed (403), and one over its
 * hourly filings (429).
 */
export const FEEDBACK_SERVER_KEY_DOOR_CODES = {
	FEEDBACK_SERVER_KEY_UNKNOWN: 401,
	FEEDBACK_SERVER_KEY_REVOKED: 401,
	FEEDBACK_SERVER_KEY_EXPIRED: 401,
	FEEDBACK_SERVER_KEY_NOT_ITS_FILING: 403,
	FEEDBACK_SERVER_KEY_RATE_LIMITED: 429,
} as const;
