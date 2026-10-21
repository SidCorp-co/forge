// Feedback about Forge itself (REQ-47): what anyone working in any project reports about Forge — its
// CLI, its routes, its guides, its web app — filed into the one project the instance names as Forge's
// home, as the reporter's own account. A project's own feedback is the project door
// (`project_feedback`, `/api/projects/:id/feedback`); this door never writes into a client project.

import { z } from "zod";
import {
	FEEDBACK_KINDS,
	FEEDBACK_LIMITS,
	FEEDBACK_SEVERITIES,
	type FeedbackKind,
	type FeedbackOriginView,
	type FeedbackPhase,
	type FeedbackRoute,
	type FeedbackSeverity,
} from "./feedback.js";
import type { ProductProgress } from "./product-progress.js";
import type { RefusalStatuses } from "./refusal.js";
import { titleText } from "./title-text.js";
import { WRITTEN_LANG_SHAPE, writtenLangSchema } from "./written-lang.js";

export const FORGE_FEEDBACK_LIMITS = {
	signalKey: 200,
	clientVersion: 100,
} as const;

/** Printable text with no control character: a key or a version is one line. */
const oneLine = (max: number) =>
	z
		.string()
		.trim()
		.min(1)
		.max(max)
		.regex(/^[^\p{Cc}]+$/u, "one line of printable text");

/** Where the reporter was when they met it, beyond what their credential already says. */
export const forgeFeedbackFromSchema = z.strictObject({
	/** The project they were working in; it must be one they can read. */
	project: z.uuid().optional(),
	/** The issue they were working on, in that project. */
	issue: z.uuid().optional(),
	/** The run they were in, in that project. */
	run: z.uuid().optional(),
});
export type ForgeFeedbackFrom = z.infer<typeof forgeFeedbackFromSchema>;

/** `POST /api/forge/feedback`, and `forge_feedback` action `submit`. */
export const forgeFeedbackRequestSchema = z.strictObject({
	kind: z.enum(FEEDBACK_KINDS),
	severity: z.enum(FEEDBACK_SEVERITIES).optional(),
	title: titleText(FEEDBACK_LIMITS.title),
	body: z.string().max(FEEDBACK_LIMITS.body).optional(),
	/** Where in Forge it was met: a page's address, a CLI command, a route, a tool, a guide. */
	whereSeen: z.string().trim().min(1).max(FEEDBACK_LIMITS.whereSeen),
	writtenLang: writtenLangSchema.optional(),
	/**
	 * What it is about, said the same way by everyone who meets it (`cli:forge claim:lease-refused`).
	 * Absent, it is the kind and the title, folded to lower case and single spaces.
	 */
	signalKey: oneLine(FORGE_FEEDBACK_LIMITS.signalKey).optional(),
	/** The client and its version the reporter used (`forge-plugin 3.36.542`, `web 0.4.0-dev.258`). */
	clientVersion: oneLine(FORGE_FEEDBACK_LIMITS.clientVersion).optional(),
	from: forgeFeedbackFromSchema.optional(),
});
export type ForgeFeedbackRequest = z.infer<typeof forgeFeedbackRequestSchema>;
export const FORGE_FEEDBACK_SHAPE = `{ kind: ${FEEDBACK_KINDS.join(" | ")}, title, whereSeen (where in Forge: a page, a command, a route, a tool, a guide), body?, severity?: ${FEEDBACK_SEVERITIES.join(" | ")}, signalKey?, clientVersion?, from?: { project?, issue?, run? } (uuids), ${WRITTEN_LANG_SHAPE} }`;

/**
 * Where in Forge a report was met, as one field: `forge_feedback` takes it in place of `whereSeen`,
 * since a model calling a tool fills every optional property it is shown, and a target split over
 * several of them came back with all of them filled.
 */
export const FORGE_FEEDBACK_TARGET_KINDS = [
	"page",
	"command",
	"route",
	"tool",
	"guide",
	"skill",
	"other",
] as const;
export type ForgeFeedbackTargetKind = (typeof FORGE_FEEDBACK_TARGET_KINDS)[number];
export const forgeFeedbackTargetSchema = z.strictObject({
	kind: z.enum(FORGE_FEEDBACK_TARGET_KINDS),
	ref: z.string().trim().min(1).max(FEEDBACK_LIMITS.whereSeen - 10),
});
export type ForgeFeedbackTarget = z.infer<typeof forgeFeedbackTargetSchema>;

/** The `whereSeen` a target stands for: `command forge claim --next`. */
export const whereSeenOf = (t: ForgeFeedbackTarget) => `${t.kind} ${t.ref}`;

/** `POST /api/admin/forge-feedback/carry-agent-reports`. */
export const carryAgentReportsRequestSchema = z.strictObject({
	/** Says what the carry would file and refuse, and writes nothing. */
	dryRun: z.boolean().optional(),
});
export type CarryAgentReportsRequest = z.infer<
	typeof carryAgentReportsRequestSchema
>;

export const FORGE_FEEDBACK_REFUSAL_CODES = [
	"FORGE_HOME_NOT_SET",
	"FORGE_FEEDBACK_CHANNEL_ACCOUNT",
	"FORGE_FEEDBACK_SOURCE_UNREADABLE",
	"FORGE_FEEDBACK_SOURCE_MISMATCH",
	"FORGE_FEEDBACK_NOT_FOUND",
] as const;
export type ForgeFeedbackRefusalCode =
	(typeof FORGE_FEEDBACK_REFUSAL_CODES)[number];

export const FORGE_FEEDBACK_REFUSAL_STATUSES = {
	FORGE_HOME_NOT_SET: 409,
	FORGE_FEEDBACK_CHANNEL_ACCOUNT: 403,
	FORGE_FEEDBACK_SOURCE_UNREADABLE: 403,
	FORGE_FEEDBACK_NOT_FOUND: 404,
} as const satisfies RefusalStatuses<ForgeFeedbackRefusalCode>;

/** One item of feedback about Forge, as its reporter reads it. */
export interface ForgeFeedbackItem {
	key: string;
	title: string;
	kind: FeedbackKind;
	severity: FeedbackSeverity;
	phase: FeedbackPhase;
	route: { route: FeedbackRoute; carriers: (string | null)[] } | null;
	/** Who filed it, where they were, and how many times it was reported. */
	origin: FeedbackOriginView | null;
	createdAt: string;
	updatedAt: string;
	progress: ProductProgress;
}

export interface ForgeFeedbackFiled {
	/** False where the report was an occurrence of an open item with its signal key. */
	created: boolean;
	feedback: ForgeFeedbackItem;
}

export interface ForgeFeedbackList {
	feedback: ForgeFeedbackItem[];
	returned: number;
	/** The project feedback about Forge is filed into. */
	home: { id: string; slug: string; name: string };
	asOf: string;
}

/** What a carry of the retired agent reports did, or would do on a dry run. */
export interface CarryAgentReportsResult {
	dryRun: boolean;
	/** One item per signal key, each with the reports it carried. */
	items: {
		signalKey: string;
		key: string | null;
		created: boolean;
		reports: number;
	}[];
	/** Reports already carried by an earlier run, which this one wrote nothing for. */
	alreadyCarried: number;
	/** Reports triaged before the door was retired (filed, dismissed, duplicate), left where they went. */
	leftTriaged: number;
	/** Reports whose author could not be resolved: never filed under a substitute account. */
	refused: { report: string; signalKey: string; why: string }[];
}
