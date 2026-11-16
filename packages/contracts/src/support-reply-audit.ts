// A room agent's audit of its own reply (ISS-1250; owner 2026-11-16, "teach the flow, not block it"):
// right after a reply is posted, the agent scores it against one rubric with support.audit, and the
// verdict is kept, readable per project and per bot, with how many replies went unaudited. Nothing
// blocks, rewrites or judges a reply on the agent's behalf; a failed line is a room correction in
// the lessons store (REQ-50). The rubric is declared once, here, for every room, bot and project.

import { z } from "zod";
import { REASON_LINE_MAX } from "./reason-text.js";
import { supportThreadIdSchema } from "./support.js";
import {
	SUPPORT_ROOM_KINDS,
	type SupportRoomKind,
} from "./support-operations.js";

/** The rubric, line by line: what each line asks of a reply. Declared once, here. */
export const REPLY_RUBRIC = {
	answered: "It answers what was asked, or does the act asked for.",
	in_context:
		"It reads the message as a ruling on what the thread's last messages said, never one line alone.",
	used_context:
		"It uses what the thread already holds: what was posted, asked and decided there.",
	knew_asker:
		"It knows who it answers: their name, their role, what they asked before.",
	tone_fit_role:
		"Its tone and depth fit the asker's role: an owner gets decisions and results, no internals.",
	no_grant_talk:
		"It never speaks of its own grants, permissions or what the room lets it do.",
	no_ui_directions:
		"It never sends a person to click or do the act in a UI; it acts or hands it on.",
	accurate: "Every claim it makes is true, and none is beside the point.",
	web_links:
		"Every link for a person points at the web host, never the API host.",
	language: "It is written in the project's content language.",
	silence: "Speaking was right here: the message asked for a reply.",
} as const;
export type ReplyRubricLine = keyof typeof REPLY_RUBRIC;
export const REPLY_RUBRIC_LINES = Object.keys(REPLY_RUBRIC) as [
	ReplyRubricLine,
	...ReplyRubricLine[],
];

export const REPLY_VERDICTS = ["pass", "fail"] as const;
export type ReplyVerdict = (typeof REPLY_VERDICTS)[number];

/** Who found a failed line: the agent's own reading, or core's check of what code can tell. */
export const REPLY_FINDERS = ["agent", "code"] as const;
export type ReplyFinder = (typeof REPLY_FINDERS)[number];

export interface ReplyFinding {
	line: ReplyRubricLine;
	why: string;
	by: ReplyFinder;
}

/** The most capabilities one audit names as missed. */
export const SUPPORT_AUDIT_MISSED_MAX = 8;

/** A capability an audit says its reply missed, by the door id the catalog names it with. */
export interface ReplyMiss {
	door: string;
	why: string;
}

/**
 * support.audit: the agent's own reading of one reply it posted, by its chat message id: each rubric
 * line it fails, with why; an empty list where it fails none.
 */
export const supportAuditRequestSchema = z.strictObject({
	thread: supportThreadIdSchema,
	message: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
		.describe("the reply you audit: the messageId reply answered you"),
	failed: z
		.array(
			z.strictObject({
				line: z.enum(REPLY_RUBRIC_LINES),
				why: z.string().trim().min(3).max(REASON_LINE_MAX),
			}),
		)
		.max(REPLY_RUBRIC_LINES.length)
		.describe(
			"each rubric line the reply fails, with why; [] where it fails none",
		),
	missed: z
		.array(
			z.strictObject({
				door: z.string().trim().min(3).max(300),
				why: z.string().trim().min(3).max(REASON_LINE_MAX),
			}),
		)
		.max(SUPPORT_AUDIT_MISSED_MAX)
		.optional()
		.describe(
			"each capability this reply should have reached for and did not, by its name as forge_find lists it (`support.member`), with why; leave it out where none",
		),
});
export type SupportAuditRequest = z.infer<typeof supportAuditRequestSchema>;

/** What an audit answers: the verdict kept, with what code found beside the agent's own reading. */
export interface SupportAuditView {
	verdict: ReplyVerdict;
	failed: ReplyRubricLine[];
	findings: ReplyFinding[];
	/** The capabilities the agent said this reply missed; the capabilities page counts them per card. */
	missed: ReplyMiss[];
	/** The room correction a failed verdict became in the lessons store. */
	correctionId: string | null;
	/** The reply was audited before; this is that verdict, unchanged. */
	already: boolean;
}

/** `GET /api/projects/:id/support/reply-verdicts`: the newest first, by bot, verdict and room kind. */
export const replyVerdictsQuerySchema = z.strictObject({
	/** The bot: the Rocket.Chat connection whose account posted the reply. */
	bot: z.uuid().optional(),
	verdict: z.enum(REPLY_VERDICTS).optional(),
	roomKind: z.enum(SUPPORT_ROOM_KINDS).optional(),
	since: z.iso.datetime({ offset: true }).optional(),
	limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ReplyVerdictsQuery = z.infer<typeof replyVerdictsQuerySchema>;
export const REPLY_VERDICTS_SHAPE =
	"?bot=<connection uuid>&verdict=pass|fail&roomKind=support|operations|agent&since=<ISO datetime>&limit=1..200, each optional";
export const REPLY_VERDICTS_LIMIT = 50;

export interface ReplyVerdictView {
	id: string;
	bot: string;
	roomId: string;
	rid: string;
	roomKind: SupportRoomKind;
	thread: string;
	/** The reply's chat message id. */
	message: string;
	verdict: ReplyVerdict;
	failed: ReplyRubricLine[];
	findings: ReplyFinding[];
	missed: ReplyMiss[];
	correctionId: string | null;
	auditedAt: string;
}

export interface ReplyVerdictsView {
	verdicts: ReplyVerdictView[];
	/** The window held more than `limit`. */
	truncated: boolean;
	/**
	 * Per bot, over the same bot, room kind and window: the replies it posted, how many of them its
	 * agent audited, and how those passed and failed. `replies - audited` went unaudited.
	 */
	bots: Array<{
		bot: string;
		replies: number;
		audited: number;
		pass: number;
		fail: number;
	}>;
}
