// The after-send audit of a room's lines (ISS-1250, owner 2026-11-16: "audit every bot message for
// quality as soon as it is sent"). One rubric for every room kind, every bot and every project: the
// judge in core (`support/reply-audit/`) reads each stored line against it, its verdict is kept per
// line, and a failed one is a room correction in the lessons store (REQ-50). No project keeps a copy.

import { z } from "zod";
import {
	SUPPORT_ROOM_KINDS,
	type SupportRoomKind,
} from "./support-operations.js";

/** The rubric, line by line: what each line asks of a stored room line. Declared once, here. */
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
	silence: "Its silence, or its speaking, was right for the message.",
} as const;
export type ReplyRubricLine = keyof typeof REPLY_RUBRIC;
export const REPLY_RUBRIC_LINES = Object.keys(
	REPLY_RUBRIC,
) as ReplyRubricLine[];

/** What was judged: a line the agent posted, a silence it kept, or a line core wrote in its place. */
export const REPLY_SUBJECTS = ["reply", "silence", "core_line"] as const;
export type ReplySubject = (typeof REPLY_SUBJECTS)[number];

/** `unjudged`: the model gave no answer and no rubric line failed in code. */
export const REPLY_VERDICTS = ["pass", "fail", "unjudged"] as const;
export type ReplyVerdict = (typeof REPLY_VERDICTS)[number];

/** One failed rubric line, why, and whether code or the model found it. */
export interface ReplyFinding {
	line: ReplyRubricLine;
	why: string;
	by: "code" | "model";
}

/** `GET /api/projects/:id/support/reply-verdicts`: the newest first, by bot and verdict. */
export const replyVerdictsQuerySchema = z.strictObject({
	/** The bot: the Rocket.Chat connection whose account posted the line. */
	bot: z.uuid().optional(),
	verdict: z.enum(REPLY_VERDICTS).optional(),
	roomKind: z.enum(SUPPORT_ROOM_KINDS).optional(),
	since: z.iso.datetime({ offset: true }).optional(),
	limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ReplyVerdictsQuery = z.infer<typeof replyVerdictsQuerySchema>;
export const REPLY_VERDICTS_SHAPE =
	"?bot=<connection uuid>&verdict=pass|fail|unjudged&roomKind=support|operations|agent&since=<ISO datetime>&limit=1..200, each optional";
export const REPLY_VERDICTS_LIMIT = 50;

export interface ReplyVerdictView {
	id: string;
	bot: string;
	roomId: string;
	rid: string;
	roomKind: SupportRoomKind;
	conversationId: string | null;
	messageId: string;
	subject: ReplySubject;
	verdict: ReplyVerdict;
	failed: ReplyRubricLine[];
	findings: ReplyFinding[];
	/** The model that judged it; null where code alone did. */
	model: string | null;
	/** Why the model gave no answer, where it gave none. */
	miss: string | null;
	/** The room correction a failed verdict became in the lessons store. */
	correctionId: string | null;
	judgedAt: string;
}

export interface ReplyVerdictsView {
	verdicts: ReplyVerdictView[];
	/** The window held more than `limit`. */
	truncated: boolean;
	/** Per bot, over the same filter: how many passed, failed and went unjudged. */
	bots: Array<{ bot: string } & Record<ReplyVerdict, number>>;
}
