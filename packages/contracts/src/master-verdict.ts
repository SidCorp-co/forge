// what core decides about one project's resident master on one box (ADR 0009, What core takes over:
// Placement and Retirement): the box reports the facts only the machine holds, core answers place,
// keep, leave, replace, retire or withhold, and the box opens or ends the pane it is told to.

import { z } from "zod";

/** How long a master must have had no work, no turn and no child close before it is retired. */
export const MASTER_IDLE_BEFORE_RETIRE_SECONDS = 60 * 60;
/** How long after a nudge the same work, or a limited master, is asked again. */
export const MASTER_NUDGE_REFRESH_SECONDS = 5 * 60;

const AGE_MAX = 10 * 365 * 24 * 60 * 60;
const COUNT_MAX = 100_000;
const TEXT_MAX = 1000;
const NAME_LIST_MAX = 200;

const age = z.number().int().min(0).max(AGE_MAX);
const count = z.number().int().min(0).max(COUNT_MAX);
const text = z.string().trim().min(1).max(TEXT_MAX);
const names = z.array(text).max(NAME_LIST_MAX);

/** What the pane's own hooks last said it is doing. */
export const MASTER_PANE_DOINGS = [
	"idle",
	"working",
	"awaiting_permission",
	"awaiting_children",
] as const;

/** What the pane did after the box's last nudge, read off its hooks' prompt count and state. */
export const MASTER_SINCE_NUDGE = [
	"unreported",
	"no_turn",
	"working",
	"awaiting_permission",
	"failed",
	"ran",
] as const;
export type MasterSinceNudge = (typeof MASTER_SINCE_NUDGE)[number];

export const masterFactsSchema = z.strictObject({
	/** The cause of the handover window the daemon is in, or null outside one. */
	restarting: text.nullable(),
	/** Whether the box has a terminal multiplexer to host a pane at all. */
	terminal: z.boolean(),
	/** The owner's stand-down as the box ledger records it. */
	standing: z.enum(["proceed", "stood_down", "unreadable"]),
	pane: z.enum(["absent", "alive"]),
	/** Whether this box can hear the pane: null where no pane is up, or the box did not register it (stood down, standing unread, restarting, runner not taking work). */
	capability: z.enum(["current", "stale", "unknown"]).nullable(),
	/** Whether the project's declared MCP servers could be read, which a replacement pane needs; null where no pane is up and none was read. */
	serversReadable: z.boolean().nullable(),
	/** What the box was answered this sweep: admissible issues, owed items, a waiting pool job, held job panes. */
	work: z.strictObject({
		admissible: count,
		owed: count,
		poolWaits: z.boolean(),
		jobPanes: count,
	}),
	/** The conversation the project's last pane held, whether its transcript is on this box, and whether a process still runs it. */
	conversation: z.strictObject({
		id: z.string().trim().min(1).max(200).nullable(),
		transcript: z.enum(["present", "absent", "unlocatable"]),
		elsewhere: z.enum(["none", "running", "unreadable"]),
	}),
	/** Why the pane's build or plugins are not the ones this box would place now; null when current or unjudged. */
	outdated: text.nullable(),
	/** The runs the pane holds: whose subagent may still work, and whose is over. */
	holding: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("nothing") }),
		z.strictObject({ kind: z.literal("these"), working: names, over: names }),
		z.strictObject({ kind: z.literal("unknown"), why: text }),
	]),
	/** Whether the pane's turn is over, from its hooks or, unheard, its transcript. */
	turn: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("ended") }),
		z.strictObject({ kind: z.literal("in_turn"), what: text }),
		z.strictObject({ kind: z.literal("unknown") }),
	]),
	idle: z.strictObject({
		/** Seconds since the box last read work or a held job pane for this project; null where no live master is registered. */
		noWorkForSeconds: age.nullable(),
		/** The pane's last hook, or null where the box has heard none. */
		pane: z
			.strictObject({
				doing: z.enum(MASTER_PANE_DOINGS),
				lastEvent: z.string().trim().min(1).max(64),
				lastEventAgoSeconds: age,
			})
			.nullable(),
		children: z.strictObject({
			total: count,
			unfinished: names,
			lastClosedAgoSeconds: age.nullable(),
		}),
	}),
	/** Whether the pane sits behind its account's capacity refusal. */
	limitHeld: z.boolean(),
	nudge: z.strictObject({
		/** A digest of this sweep's admissible and owed work, compared for equality only. */
		digest: z.string().trim().min(1).max(64),
		/** The box's last nudge to this master: the work it was about and how long ago. */
		last: z
			.strictObject({
				digest: z.string().trim().min(1).max(64),
				agoSeconds: age,
			})
			.nullable(),
		since: z.enum(MASTER_SINCE_NUDGE),
	}),
});
export type MasterFacts = z.infer<typeof masterFactsSchema>;

export const masterVerdictRequestSchema = z.strictObject({
	projectId: z.uuid(),
	runnerId: z.uuid(),
	facts: masterFactsSchema,
});
export const MASTER_VERDICT_SHAPE =
	"{ projectId: uuid, runnerId: uuid (the runner row being swept), facts: { restarting, terminal, standing, pane, capability, serversReadable, work, conversation, outdated, holding, turn, idle, limitHeld, nudge } } — see @forge/contracts/master-verdict masterFactsSchema";

/** Why no pane is placed, none ended and none nudged. */
export const MASTER_WITHHOLD_REASONS = [
	"standing_unreadable",
	"restarting",
	"runner_not_accepting",
	"stood_down",
	"no_terminal",
	"nothing_owed",
	"conversation_elsewhere",
	"conversation_unaskable",
] as const;
export type MasterWithholdReason = (typeof MASTER_WITHHOLD_REASONS)[number];

/** Why a standing pane is left running and not driven. */
export const MASTER_LEAVE_REASONS = ["stood_down", "deaf", "outdated"] as const;
export type MasterLeaveReason = (typeof MASTER_LEAVE_REASONS)[number];

/** Why a standing pane is ended and a successor placed in the same sweep. */
export const MASTER_REPLACE_REASONS = ["deaf", "outdated"] as const;
export type MasterReplaceReason = (typeof MASTER_REPLACE_REASONS)[number];

/**
 * `nudge` on place and replace: the new pane's brief is this pass's nudge, so the box opens a pass
 * for it and types none. `resume`: the conversation the new pane resumes, or null to start cold.
 */
export type MasterVerdict =
	| { act: "withhold"; reason: MasterWithholdReason; because: string }
	| { act: "place"; resume: string | null; nudge: boolean; because: string }
	| {
			act: "replace";
			reason: MasterReplaceReason;
			resume: string | null;
			nudge: boolean;
			because: string;
	  }
	| { act: "retire"; because: string }
	| { act: "leave"; reason: MasterLeaveReason; because: string }
	| { act: "keep"; nudge: boolean; because: string };
export type MasterVerdictAct = MasterVerdict["act"];
