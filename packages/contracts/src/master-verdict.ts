// what core decides about one project's resident master on one box (ADR 0009, What core takes over:
// Placement and Retirement): the box reports the facts only the machine holds, core answers place,
// keep, leave, replace, retire or withhold, and the box opens or ends the pane it is told to.

import { z } from "zod";
import { runSubagentSchema } from "./run-verdict.js";
import type { Said } from "./said.js";

/** How long a master must have had no work, no turn and no child close before it is retired. */
export const MASTER_IDLE_BEFORE_RETIRE_SECONDS = 60 * 60;
/** How long after a nudge the same work, or a limited master, is asked again. */
export const MASTER_NUDGE_REFRESH_SECONDS = 5 * 60;

/**
 * How old, either way, a refusal in a master's conversation may be and still speak for the account
 * (twice the limited master's poll and its nudge refresh).
 */
export const MASTER_LIMIT_FRESH_SECONDS = 2 * (5 * 60 + MASTER_NUDGE_REFRESH_SECONDS);

const AGE_MAX = 10 * 365 * 24 * 60 * 60;
const COUNT_MAX = 100_000;
const TEXT_MAX = 1000;
const NAME_LIST_MAX = 200;

const age = z.number().int().min(0).max(AGE_MAX);
const ageMs = z
	.number()
	.int()
	.min(0)
	.max(AGE_MAX * 1000);
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

/** What a refused turn's own record says the account refused it over: a quota window, a throttle, a credential. */
export const MASTER_ACCOUNT_REFUSALS = [
	"usage_limit",
	"rate_limit",
	"auth",
] as const;

const MASTER_INPUTS_MAX = 32;

/** What a pane is handed that a rebuild can change, by name, each with its digest. */
export const masterInputsSchema = z
	.record(z.string().regex(/^[a-z][a-z_]{0,31}$/), z.string().trim().min(1).max(128))
	.refine((inputs) => Object.keys(inputs).length <= MASTER_INPUTS_MAX, {
		message: `at most ${MASTER_INPUTS_MAX} inputs`,
	});

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
	/** The work only the box holds: a pool job it took this sweep, and the job panes it holds. Admissible issues and owed items are core's own (`masters/owed.ts`). */
	work: z.strictObject({
		poolWaits: z.boolean(),
		jobPanes: count,
	}),
	/** The conversation the project's last pane held, whether its transcript is on this box, and whether a process still runs it. */
	conversation: z.strictObject({
		id: z.string().trim().min(1).max(200).nullable(),
		transcript: z.enum(["present", "absent", "unlocatable"]),
		elsewhere: z.enum(["none", "running", "unreadable"]),
	}),
	/**
	 * What the pane was placed with and what this box would hand one now, each input by name
	 * (`wire`, `skill`, `hooks`, `env`, `mcp`, `launch`, `plugins`) with its digest; whether the pane
	 * is outdated is core's reading of the two. `placed` is null where the ledger holds no record of
	 * what it was placed with, and `unreadable` carries a record it holds but this build cannot read
	 * (then `placed` is null too). Null where no pane is up or the ledger could not be read.
	 */
	placement: z
		.strictObject({
			placed: masterInputsSchema.nullable(),
			unreadable: text.nullable(),
			now: masterInputsSchema,
		})
		.nullable(),
	/** The runs the pane holds, each with what its subagent's own evidence says; whether it is over is core's. */
	holding: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("nothing") }),
		z.strictObject({
			kind: z.literal("these"),
			runs: z
				.array(z.strictObject({ name: text, subagent: runSubagentSchema }))
				.max(NAME_LIST_MAX),
		}),
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
	/** What the pane's own conversation and hooks say about its account's last refusal; core decides whether it holds the pane. */
	limit: z.strictObject({
		/** The newest record in the conversation that says anything, where it is a refusal; null where it says the account answered, or none is read. */
		refusal: z
			.strictObject({ reason: z.enum(MASTER_ACCOUNT_REFUSALS), agoMs: ageMs })
			.nullable(),
		/** Whether the pane's hooks name that conversation: `unheard` where either side is not known. */
		hooks: z.enum(["same", "other", "unheard"]),
		/** Since the pane's hooks last reported a turn starting; null where none runs. */
		turnStartedAgoMs: ageMs.nullable(),
	}),
	nudge: z.strictObject({
		/** The box's last nudge to this master: the digest core gave the work it was about, and how long ago. */
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
	"{ projectId: uuid, runnerId: uuid (the runner row being swept), facts: { restarting, terminal, standing, pane, capability, serversReadable, work, conversation, placement, holding, turn, idle, limit, nudge } } — see @forge/contracts/master-verdict masterFactsSchema";

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

/** Why a standing pane is left running and not driven. An outdated pane is never left: it is kept and driven, draining. */
export const MASTER_LEAVE_REASONS = ["stood_down", "deaf"] as const;
export type MasterLeaveReason = (typeof MASTER_LEAVE_REASONS)[number];

/** Why a standing pane is ended and a successor placed in the same sweep. */
export const MASTER_REPLACE_REASONS = ["deaf", "outdated"] as const;
export type MasterReplaceReason = (typeof MASTER_REPLACE_REASONS)[number];

/**
 * `nudge` on place and replace: the new pane's brief is this pass's nudge, so the box opens a pass
 * for it and types none. `resume`: the conversation the new pane resumes, or null to start cold.
 * `drain` on keep: the pane is outdated and its replacement waits on what it holds, so the box admits
 * no new run declaration from it until that runs out (a graceful stop: finish what is held, take
 * nothing new). It is still nudged on a current master's timing for the work it is owed.
 */
/** A verdict's reason as the registry sentence its English `because` was rendered from. */
export interface MasterVerdictSays {
	because: Said;
}

export type MasterVerdict = (
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
	| { act: "keep"; nudge: boolean; drain: boolean; because: string }
) & { says: MasterVerdictSays };
export type MasterVerdictAct = MasterVerdict["act"];

/** The work core read for the project this sweep: what decides a pass, and what the box types or briefs. */
export interface MasterWork {
	admissible: number;
	owed: number;
	/** A digest of the admissible and owed work; the box echoes it as `facts.nudge.last.digest` once it nudged on it. */
	digest: string;
	/** The line the box types into a kept pane it is told to nudge. */
	nudge: string;
	/** What a first pass owes, for the brief of a pane placed now; empty where nothing is owed. */
	owedLine: string;
	/** The issue a pass opened on this work is about: the one admissible issue, where nothing else is owed. */
	issueKey: string | null;
}

/** What `POST /me/master-session/verdict` answers: the verdict, and the work it was judged against. */
export interface MasterVerdictAnswer {
	verdict: MasterVerdict;
	work: MasterWork;
}

/** The newest decisive record a box read in its masters' conversations, as it wrote it; the age is the box's own clock's. */
export const masterLimitRecordSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("refused"),
		/** Seconds since the record was written; negative where the box's clock reads it ahead. */
		agoSeconds: z.number().int().min(-AGE_MAX).max(AGE_MAX),
		reason: z.enum(MASTER_ACCOUNT_REFUSALS),
		/** Seconds until the account is expected back; null for `auth` and for a quota window the record gives no reset for. */
		resetsInSeconds: z.number().int().min(0).max(7 * 24 * 60 * 60).nullable(),
		detail: z.string().trim().min(1).max(200),
	}),
	z.strictObject({
		kind: z.literal("worked"),
		agoSeconds: z.number().int().min(-AGE_MAX).max(AGE_MAX),
	}),
	/** A refusal this build was not taught to read, named by its slug. */
	z.strictObject({ kind: z.literal("unreadable"), slug: text }),
]);
export type MasterLimitRecord = z.infer<typeof masterLimitRecordSchema>;

/** What core did with a record: `reported` and `cleared` changed the runner rows, the rest left them. */
const MASTER_LIMIT_OUTCOMES = [
	"reported",
	"held",
	"stale",
	"cleared",
	"nothing",
	"unreadable",
] as const;
export type MasterLimitOutcome = (typeof MASTER_LIMIT_OUTCOMES)[number];
