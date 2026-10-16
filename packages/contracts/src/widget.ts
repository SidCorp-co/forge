// The feedback widget: a chat a client site embeds so its own end users reach a project's limited
// assistant, which pins a problem down at the user's level and, once the visitor confirms the
// draft, files it as Feedback. The visitor is never a Forge user and the assistant reads nothing of
// the project; the visitor's way back is a private status link.
//
// One `widget` integration binding per project label holds the public site key, the origins allowed
// to embed it, how a visitor is identified, and the assistant's limits. Every route here is public:
// the site key names the binding, the Origin header is checked against it, and a visitor session
// token (shown once, stored as its SHA-256) carries everything after the session opens.

import { z } from "zod";
import type { RefusalStatuses } from "./refusal.js";

/**
 * How a project wants a visitor identified, chosen per binding:
 * - `anonymous`: anyone may chat; an email is taken only if the visitor offers one.
 * - `email`: a session opens only with an email the visitor gives.
 * - `signed`: the client's own backend vouches for its user, `sig` being the hex HMAC-SHA256 of
 *   `${userId}.${ts}` under the binding's signing secret; `ts` (unix seconds) within
 *   `WIDGET_SIGNATURE_MAX_AGE_S` of now.
 */
export const WIDGET_IDENTITY_MODES = ["anonymous", "email", "signed"] as const;
export type WidgetIdentityMode = (typeof WIDGET_IDENTITY_MODES)[number];
export const WIDGET_SIGNATURE_MAX_AGE_S = 600;

/** The public key a page embeds: this prefix and 32 base64url characters. Not a secret. */
export const WIDGET_SITE_KEY_PREFIX = "fw_site_";
export const WIDGET_SITE_KEY_PATTERN = /^fw_site_[A-Za-z0-9_-]{32}$/;

/** A visitor session token: shown once to the iframe, stored only as its SHA-256. */
export const WIDGET_SESSION_TOKEN_PREFIX = "fw_sess_";
export const WIDGET_SESSION_TOKEN_PATTERN = /^fw_sess_[A-Za-z0-9_-]{43}$/;

/** A status link token: 256 random bits, stored only as its SHA-256, never expiring by itself. */
export const WIDGET_STATUS_TOKEN_PREFIX = "fw_stat_";
export const WIDGET_STATUS_TOKEN_PATTERN = /^fw_stat_[A-Za-z0-9_-]{43}$/;
/** Where a visitor opens a status link, under the web origin. */
export const widgetStatusPath = (token: string) => `/w/status/${token}`;
/** The iframe page the loader opens, under the web origin. */
export const widgetFramePath = (siteKey: string) => `/w/${siteKey}`;

/**
 * The v1 caps, the anti-abuse floor until the owner asks for more (captcha deferred, 2026-10-16):
 * enough that one visitor or one leaked site key cannot run model cost away.
 */
export const WIDGET_LIMIT_DEFAULTS = {
	messageMaxChars: 4000,
	turnsPerConversation: 30,
	turnsPerVisitorPerDay: 60,
	sessionsPerAddressPerHour: 30,
} as const;

export const widgetLimitsSchema = z.strictObject({
	messageMaxChars: z.number().int().min(200).max(8000).optional(),
	turnsPerConversation: z.number().int().min(1).max(200).optional(),
	turnsPerVisitorPerDay: z.number().int().min(1).max(1000).optional(),
	sessionsPerAddressPerHour: z.number().int().min(1).max(1000).optional(),
});

/** An exact origin a page may embed the widget from: scheme, host and optional port, no path. */
export const widgetOriginSchema = z
	.string()
	.max(300)
	.regex(
		/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/,
		"an origin: scheme://host[:port], lower case, no path",
	);

/** The binding's config, as Settings → Integrations writes it. The signing secret is a secret, not here. */
export const widgetBindingConfigSchema = z.strictObject({
	siteKey: z.string().regex(WIDGET_SITE_KEY_PATTERN),
	allowedOrigins: z.array(widgetOriginSchema).min(1).max(20),
	identity: z.strictObject({ mode: z.enum(WIDGET_IDENTITY_MODES) }),
	title: z.string().min(1).max(60).optional(),
	greeting: z.string().min(1).max(400).optional(),
	/** A CSS colour the frame accents with, `#rrggbb`. */
	accent: z
		.string()
		.regex(/^#[0-9a-fA-F]{6}$/)
		.optional(),
	limits: widgetLimitsSchema.optional(),
});
export type WidgetBindingConfig = z.infer<typeof widgetBindingConfigSchema>;

/**
 * Where the visitor was, as the host page reports it through the loader. Every field is the client
 * page's own claim: stored and shown as data, never trusted as instructions or as identity.
 */
export const widgetPageContextSchema = z.strictObject({
	url: z.url().max(2000),
	title: z.string().max(300).optional(),
	productId: z.string().max(200).optional(),
	appVersion: z.string().max(100).optional(),
	locale: z.string().max(35).optional(),
	userAgent: z.string().max(500).optional(),
	/** Anything else the client wants on the record, flat strings, at most 20 keys. */
	extra: z.record(z.string().max(60), z.string().max(500)).optional(),
});
export type WidgetPageContext = z.infer<typeof widgetPageContextSchema>;

/** GET /api/widget/:siteKey/config — what the frame needs before a session opens. */
export interface WidgetPublicConfig {
	title: string;
	greeting: string | null;
	accent: string | null;
	identity: { mode: WidgetIdentityMode };
	messageMaxChars: number;
}

/** POST /api/widget/:siteKey/sessions */
export const widgetSessionRequestSchema = z.strictObject({
	visitor: z
		.strictObject({
			email: z.email().max(320).optional(),
			name: z.string().min(1).max(120).optional(),
		})
		.optional(),
	signed: z
		.strictObject({
			userId: z.string().min(1).max(200),
			ts: z.number().int(),
			sig: z.string().regex(/^[0-9a-f]{64}$/),
			email: z.email().max(320).optional(),
			name: z.string().min(1).max(120).optional(),
		})
		.optional(),
	context: widgetPageContextSchema.optional(),
	/** A visitor id the frame kept from an earlier session on this site, to continue as the same visitor. */
	visitorId: z.uuid().optional(),
});
export type WidgetSessionRequest = z.infer<typeof widgetSessionRequestSchema>;

export interface WidgetSession {
	sessionToken: string;
	visitorId: string;
	conversationId: string;
	expiresAt: string;
}

/** POST /api/widget/session/messages — `Authorization: Bearer <session token>`. */
export const widgetMessageRequestSchema = z.strictObject({
	text: z.string().min(1).max(8000),
	context: widgetPageContextSchema.optional(),
});

/** What the assistant proposes to file; the visitor confirms or discards it in the frame. */
export interface WidgetFeedbackDraft {
	draftId: string;
	title: string;
	/** What the visitor did, saw and expected, in the visitor's words as the assistant summed them up. */
	did: string | null;
	saw: string;
	expected: string | null;
	whereSeen: string | null;
	kind: "bug" | "change_request" | "idea" | "question";
	state: "pending" | "filed" | "discarded";
}

/** One line of the conversation as the frame shows it. */
export interface WidgetMessage {
	id: string;
	role: "visitor" | "assistant";
	text: string;
	at: string;
}

/**
 * GET /api/widget/session/stream — server-sent events on the session token, one JSON per event.
 * `filed` carries the status link the frame shows the visitor; `limit` says which cap was met.
 */
export type WidgetStreamEvent =
	| { type: "message"; message: WidgetMessage }
	| { type: "typing"; on: boolean }
	| { type: "draft"; draft: WidgetFeedbackDraft }
	| { type: "filed"; draftId: string; feedbackKey: string; statusUrl: string }
	| { type: "limit"; code: WidgetRefusalCode; detail: string };

/** GET /api/widget/session/messages — the history, oldest first, and any open draft. */
export interface WidgetHistory {
	messages: WidgetMessage[];
	drafts: WidgetFeedbackDraft[];
}

/** POST /api/widget/session/drafts/:draftId/confirm answers this; .../discard answers the draft. */
export interface WidgetFiled {
	feedbackKey: string;
	statusUrl: string;
}

/** GET /api/widget/status/:token — what a visitor may know of what they filed, and nothing more. */
export interface WidgetStatus {
	feedbackKey: string;
	title: string;
	/** received → triaged → in_progress → shipped, or closed (declined, duplicate, answered). */
	phase: "received" | "triaged" | "in_progress" | "shipped" | "closed";
	/** One plain sentence for the visitor; never an internal name, an issue key or a person. */
	says: string;
	filedAt: string;
	updatedAt: string;
}

/**
 * The messages between the loader on the host page and the frame, all `postMessage` with this
 * `source`. The frame accepts them only from the binding's allowed origins.
 */
export const WIDGET_POST_MESSAGE_SOURCE = "forge-widget";
export type WidgetHostMessage =
	| {
			source: typeof WIDGET_POST_MESSAGE_SOURCE;
			type: "context";
			context: WidgetPageContext;
	  }
	| {
			source: typeof WIDGET_POST_MESSAGE_SOURCE;
			type: "identify";
			signed: NonNullable<WidgetSessionRequest["signed"]>;
	  }
	| { source: typeof WIDGET_POST_MESSAGE_SOURCE; type: "open" | "close" };
export type WidgetFrameMessage =
	| { source: typeof WIDGET_POST_MESSAGE_SOURCE; type: "ready" | "close" }
	| {
			source: typeof WIDGET_POST_MESSAGE_SOURCE;
			type: "unread";
			count: number;
	  };

export const WIDGET_REFUSAL_CODES = [
	"WIDGET_REFUSED",
	"WIDGET_SITE_UNKNOWN",
	"WIDGET_ORIGIN_REFUSED",
	"WIDGET_IDENTITY_REQUIRED",
	"WIDGET_SIGNATURE_INVALID",
	"WIDGET_SESSION_INVALID",
	"WIDGET_LIMIT_REACHED",
	"WIDGET_DRAFT_NOT_PENDING",
	"WIDGET_STATUS_UNKNOWN",
] as const;
export type WidgetRefusalCode = (typeof WIDGET_REFUSAL_CODES)[number];

export const WIDGET_REFUSAL_STATUSES = {
	WIDGET_SITE_UNKNOWN: 404,
	WIDGET_ORIGIN_REFUSED: 403,
	WIDGET_SIGNATURE_INVALID: 403,
	WIDGET_SESSION_INVALID: 403,
	WIDGET_LIMIT_REACHED: 409,
	WIDGET_DRAFT_NOT_PENDING: 409,
	WIDGET_STATUS_UNKNOWN: 404,
} as const satisfies RefusalStatuses<WidgetRefusalCode>;
