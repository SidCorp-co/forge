// The Share port: a frozen report document turned into something a reader opens. One target,
// `forge-link`, exists; the port is there so a later one (a mail digest, a file) is an adapter
// beside it. A target that hands the document to a third-party host is refused by the owner's
// ruling, and its descriptor cannot say otherwise: `hostedBy` is the literal "forge".

import { z } from "zod";
import type { RefusalStatuses } from "./refusal.js";
import { ReleasePageSnapshotSchema } from "./release-page.js";
import { ReportDocumentSchema } from "./report-templates.js";

export const SHARE_AUDIENCES = ["members", "link"] as const;
export type ShareAudience = (typeof SHARE_AUDIENCES)[number];
/**
 * A chat answer (`message`: any message of one assistant turn, frozen as the whole turn — its
 * question, its reply and every block it drew), a template's output, a stored status report, or a
 * release page (`release`: its user view, the subject id being the version); never a live query or
 * a conversation.
 */
export const SHARE_SUBJECT_KINDS = [
	"message",
	"template-output",
	"status-report",
	"release",
] as const;
export type ShareSubjectKind = (typeof SHARE_SUBJECT_KINDS)[number];

export const SHARE_DEFAULT_EXPIRY_DAYS = 7;
export const SHARE_MAX_EXPIRY_DAYS = 30;

/**
 * A share token: this prefix and 43 base64url characters (256 random bits), shown once at creation
 * and stored only as its SHA-256. The prefix is what lets the log scrubber
 * (`@forge/observability:scrubLogText`) find one anywhere, so it never reaches a log.
 */
export const SHARE_TOKEN_PREFIX = "forge_share_";
export const SHARE_TOKEN_PATTERN = /^forge_share_[A-Za-z0-9_-]{43}$/;
export const SHARE_TOKEN_SHAPE = `${SHARE_TOKEN_PREFIX} followed by 43 base64url characters`;
/** Where a reader opens a share, under the web origin. */
export const sharePath = (token: string) => `/s/${token}`;

export const SHARE_REFUSAL_CODES = [
	"SHARE_REFUSED",
	/** The subject kind has no source registered in this build, so nothing can be frozen from it. */
	"SHARE_SUBJECT_UNSUPPORTED",
	"SHARE_SUBJECT_NOT_FOUND",
	/** The frozen document holds a run of another project. */
	"SHARE_SUBJECT_FOREIGN",
	/** The frozen document, before or after scrubbing, is not a valid report document. */
	"SHARE_SNAPSHOT_INVALID",
	/** A link-audience share of a project whose data policy keeps its data from leaving. */
	"SHARE_EGRESS_FORBIDDEN",
	"SHARE_REVOKE_FORBIDDEN",
	"SHARE_ALREADY_REVOKED",
	"SHARE_NOT_FOUND",
	/** The one answer to opening an unknown, tampered, expired or revoked token, or one whose creator left. */
	"SHARE_NOT_AVAILABLE",
	"SHARE_TOKEN_MALFORMED",
	/** A members share opened by nobody signed in. */
	"SHARE_SIGN_IN_REQUIRED",
	/** A members share opened by someone who cannot read the project. */
	"SHARE_AUDIENCE_FORBIDDEN",
] as const;
export type ShareRefusalCode = (typeof SHARE_REFUSAL_CODES)[number];

export const SHARE_REFUSAL_STATUSES = {
	SHARE_SUBJECT_NOT_FOUND: 404,
	SHARE_ALREADY_REVOKED: 409,
	SHARE_NOT_FOUND: 404,
	SHARE_NOT_AVAILABLE: 404,
	SHARE_TOKEN_MALFORMED: 400,
	SHARE_SIGN_IN_REQUIRED: 403,
} as const satisfies RefusalStatuses<ShareRefusalCode>;

export const ShareTargetDescriptorSchema = z
	.object({
		id: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
		hostedBy: z.literal("forge", {
			error:
				"a share target is hosted by Forge; handing a report to a third-party host is not allowed",
		}),
		audiences: z.array(z.enum(SHARE_AUDIENCES)).min(1),
	})
	.strict();
export type ShareTargetDescriptor = z.infer<typeof ShareTargetDescriptorSchema>;

export const ShareCreateSchema = z
	.object({
		subjectKind: z.enum(SHARE_SUBJECT_KINDS),
		subjectId: z.string().min(1),
		audience: z.enum(SHARE_AUDIENCES),
		expiresInDays: z
			.number()
			.int()
			.min(1)
			.max(SHARE_MAX_EXPIRY_DAYS, {
				error: `a share expires within ${SHARE_MAX_EXPIRY_DAYS} days at most`,
			})
			.default(SHARE_DEFAULT_EXPIRY_DAYS),
	})
	.strict();
export type ShareCreate = z.infer<typeof ShareCreateSchema>;

/** A share as a list shows it. The token and its hash never appear: the token is shown once, at creation. */
export const ShareLinkViewSchema = z
	.object({
		id: z.string().min(1),
		projectId: z.string().min(1),
		audience: z.enum(SHARE_AUDIENCES),
		subjectKind: z.enum(SHARE_SUBJECT_KINDS),
		/** The frozen, scrubbed snapshot's own title (a shared answer's question), else its first block title, so two links of one kind read apart; null when it has neither. */
		title: z.string().nullable(),
		createdBy: z.string().min(1),
		createdAt: z.iso.datetime(),
		expiresAt: z.iso.datetime(),
		revokedAt: z.iso.datetime().nullable(),
		revokedBy: z.string().nullable(),
		viewCount: z.number().int().min(0),
		lastViewedAt: z.iso.datetime().nullable(),
	})
	.strict();
export type ShareLinkView = z.infer<typeof ShareLinkViewSchema>;

/** Where a share stands for a reader of its list: still opening, past its date, or revoked. */
export const SHARE_STATES = ["active", "expired", "revoked"] as const;
export type ShareState = (typeof SHARE_STATES)[number];

/**
 * A listed share's state, read off its own fields at `now`: a revocation outranks an expiry. A share
 * whose creator has left still reads `active` here; opening it is what answers not available.
 */
export function shareStateOf(
	share: Pick<ShareLinkView, "revokedAt" | "expiresAt">,
	now: number = Date.now(),
): ShareState {
	if (share.revokedAt !== null) return "revoked";
	return Date.parse(share.expiresAt) <= now ? "expired" : "active";
}

/** What creating a share answers: the share, and the one time its link is shown. */
export const ShareCreatedSchema = z
	.object({ share: ShareLinkViewSchema, url: z.string().min(1) })
	.strict();
export type ShareCreated = z.infer<typeof ShareCreatedSchema>;

/**
 * Whether the asker may create a share for one audience, read by core with the same checks creating
 * one makes: open, or the refusal creating it would answer, by its code and core's own sentence.
 */
export const ShareAudienceOptionSchema = z
	.object({
		audience: z.enum(SHARE_AUDIENCES),
		refusal: z
			.object({ code: z.string().min(1), message: z.string().min(1) })
			.strict()
			.nullable(),
	})
	.strict();
export type ShareAudienceOption = z.infer<typeof ShareAudienceOptionSchema>;

/** Opening a share: the token travels in the body, never in a path a log or a proxy keeps. */
export const ShareOpenSchema = z
	.object({ token: z.string().min(1).max(200) })
	.strict();
export type ShareOpen = z.infer<typeof ShareOpenSchema>;

/** What a reader opens: the frozen document, read-only. For a `link` audience a ref cell is drawn as text. */
export const ShareSnapshotSchema = z
	.object({
		audience: z.enum(SHARE_AUDIENCES),
		expiresAt: z.iso.datetime(),
		document: ReportDocumentSchema,
	})
	.strict();
export type ShareSnapshot = z.infer<typeof ShareSnapshotSchema>;

/**
 * What a reader opens of a `release` share: the release page's user view as it was frozen, read-only.
 * Each clip or picture carries a short-lived link minted for this opening only.
 */
export const ShareReleaseSnapshotSchema = z
	.object({
		audience: z.enum(SHARE_AUDIENCES),
		expiresAt: z.iso.datetime(),
		release: ReleasePageSnapshotSchema,
	})
	.strict();
export type ShareReleaseSnapshot = z.infer<typeof ShareReleaseSnapshotSchema>;

/** Anything opening a share answers: a frozen report document, or a frozen release page. */
export const ShareOpenedSchema = z.union([
	ShareSnapshotSchema,
	ShareReleaseSnapshotSchema,
]);
export type ShareOpened = z.infer<typeof ShareOpenedSchema>;

export const isReleaseShare = (
	opened: ShareOpened,
): opened is ShareReleaseSnapshot => "release" in opened;

/** What a share freezes and keeps: a report document, or a release page's user view. */
export type ShareFrozen =
	| z.infer<typeof ReportDocumentSchema>
	| z.infer<typeof ReleasePageSnapshotSchema>;

/** The port. `publish` takes the frozen document and returns where a reader opens it. */
export interface ShareTarget extends ShareTargetDescriptor {
	publish(input: {
		projectId: string;
		audience: ShareAudience;
		subjectKind: ShareSubjectKind;
		expiresAt: Date;
		document: ShareFrozen;
		createdBy: string;
	}): Promise<{ id: string; url: string }>;
}
