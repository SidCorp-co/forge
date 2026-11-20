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
	language:
		"It is written in the language the person wrote in, else the one the persona names; never the records' language.",
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
 * What an audit says its output missed: each capability by the door the catalog names it with, read
 * against that catalog where it is kept. One shape for a room agent's audit and every other agent's.
 */
export const auditMissedSchema = z
	.array(
		z.strictObject({
			door: z.string().trim().min(3).max(300),
			why: z.string().trim().min(3).max(REASON_LINE_MAX),
		}),
	)
	.max(SUPPORT_AUDIT_MISSED_MAX);

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
	missed: auditMissedSchema
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

// Every other agent's audit of its own output (ISS-1251 c4): a master, a run it starts and the steward
// score what they shipped against their cards' red flags and their role's rubric, and name what they
// missed, in the shape a room agent's support.audit takes. Kept in the one verdict store, so the
// capabilities page counts every kind's misses by one read. Nothing makes an agent audit; its card
// teaches when.

/** The agents that audit their own output beside a room's. */
export const SELF_AUDIT_ROLES = ["master", "run", "steward"] as const;
export type SelfAuditRole = (typeof SELF_AUDIT_ROLES)[number];

const STATE_TRUE =
	"Every status, mark and comment it left says what is true: fixed, released and live told apart.";
const DEFECTS_PLACED =
	"Every defect it saw went to one place: fixed, recorded as debt, or routed to its owner.";

/** Each role's rubric, line by line: what its output owes. Declared once, here. */
export const ROLE_RUBRICS = {
	master: {
		delegated:
			"It built nothing beyond a change too small to brief; each build part went to a run.",
		one_gate:
			"What landed went through the batch's one gate, its report recorded on each issue it landed.",
		state_true: STATE_TRUE,
		defects_placed: DEFECTS_PLACED,
		asked_only_owed:
			"It asked a person only for something irreversible, money, credentials or a new direction.",
		tidy: "It left no worktree, scratch folder or process behind once the work landed.",
	},
	run: {
		criteria_proven:
			"Each criterion it calls met is proven by a run, a probe or a verdict on the record.",
		in_scope:
			"It did the issue's work and what bounds or proves it, and nothing beside it.",
		refused_loudly:
			"Wrong input is refused by name; nothing was widened, guessed or skipped in silence.",
		state_true: STATE_TRUE,
		defects_placed: DEFECTS_PLACED,
		docs_true: "No doc it touched disagrees with the code it changed.",
	},
	steward: {
		delta_only:
			"It changed a card or a lesson by delta, never rewrote one whole.",
		read_first:
			"Each lesson it drew was drawn after its thread or item was read, an owner's ruling quoted.",
		anchored:
			"Each lesson it admitted is anchored to a card, a BC or a file.ts:symbol.",
		writes_named:
			"Each write a door refused is named in done, and none it fixed by resending is.",
		state_true: STATE_TRUE,
	},
} as const satisfies Record<SelfAuditRole, Record<string, string>>;

/** How a tripped red flag is kept among the failed lines: the door whose card names it. */
export const RED_FLAG_LINE_PREFIX = "red_flag:";

/** The most lines one self-audit names as failed. */
export const SELF_AUDIT_FAILED_MAX = 12;

/**
 * Each line the output fails, with why: a line of the role's rubric, or the red flag of a card it
 * tripped, named by that card's door as your map or forge_find names it.
 */
export const selfAuditFailedSchema = z
	.array(
		z.strictObject({
			line: z
				.string()
				.trim()
				.min(3)
				.max(40)
				.optional()
				.describe("a line of your role's rubric"),
			redFlag: z
				.string()
				.trim()
				.min(3)
				.max(300)
				.optional()
				.describe(
					"the door whose card's red flag you tripped, as your map or forge_find names it (`issues.transition`, `issues.merge`)",
				),
			why: z.string().trim().min(3).max(REASON_LINE_MAX),
		}),
	)
	.max(SELF_AUDIT_FAILED_MAX);
export type SelfAuditFailed = z.infer<typeof selfAuditFailedSchema>;

/**
 * Each failed entry that names neither or both of a rubric line and a red flag, or a line the role's
 * rubric does not hold, by its path and with the lines it does.
 */
export function rubricFaults(
	role: SelfAuditRole,
	failed: SelfAuditFailed | undefined,
): { path: (string | number)[]; message: string }[] {
	const lines = Object.keys(ROLE_RUBRICS[role]);
	const out: { path: (string | number)[]; message: string }[] = [];
	for (const [i, f] of (failed ?? []).entries()) {
		if ((f.line === undefined) === (f.redFlag === undefined)) {
			out.push({
				path: ["failed", i],
				message:
					"name one of `line` (a rubric line) or `redFlag` (the door whose card's red flag you tripped)",
			});
		} else if (f.line !== undefined && !lines.includes(f.line)) {
			out.push({
				path: ["failed", i, "line"],
				message: `${f.line} is no line of the ${role} rubric: ${lines.join(", ")}`,
			});
		}
	}
	return out;
}

/** The output an audit is about: an issue the master or run worked, by its key or uuid. */
export const SELF_AUDIT_OUTPUT_KINDS = ["issue"] as const;

const selfAuditFields = {
	as: z
		.enum(["master", "run"])
		.describe(
			"the role whose rubric you audit by: master, or run for a session building an issue",
		),
	output: z
		.strictObject({
			kind: z.enum(SELF_AUDIT_OUTPUT_KINDS),
			ref: z.string().trim().min(1).max(64),
		})
		.describe("what you audit: { kind: issue, ref: ISS-n }"),
	failed: selfAuditFailedSchema.describe(
		"each rubric line or card red flag your output fails, with why; [] where it fails none",
	),
	missed: auditMissedSchema
		.optional()
		.describe(
			"each capability you should have reached for and did not, by its name as your map or forge_find gives it, with why; leave it out where none",
		),
};

/** The self-audit's fields, for a door that takes them beside its own (the MCP action's input). */
export const selfAuditRequestShape = selfAuditFields;

/**
 * `POST /api/projects/:id/self-audits` and audit.self: a master's or run's audit of its own output.
 * Its failed lines are judged against the role's rubric where it is kept (`rubricFaults`), as the
 * steward's done call's are.
 */
export const selfAuditRequestSchema = z.strictObject(selfAuditFields);
export type SelfAuditRequest = z.infer<typeof selfAuditRequestSchema>;

export const SELF_AUDIT_SHAPE =
	"{ as: master | run, output: { kind: issue, ref: ISS-n }, failed: [{ line | redFlag, why }], missed?: [{ door, why }] }";

/** What a self-audit answers: the verdict kept, and the correction a failed one became. */
export interface SelfAuditView {
	verdict: ReplyVerdict;
	/** The rubric lines failed, and each tripped red flag as `red_flag:<door>`. */
	failed: string[];
	missed: ReplyMiss[];
	/** The correction a failed verdict became in the lessons store, where its output names an item. */
	correctionId: string | null;
	/** This output was audited before in this role; this is that verdict, unchanged. */
	already: boolean;
}
