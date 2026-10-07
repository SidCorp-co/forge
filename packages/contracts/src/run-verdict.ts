// what core decides about one run the box ledger still holds open (ADR 0009, What core takes over:
// Recovery verdict): the box reports the pid, pane, transcript and checkout facts only the machine
// holds, core answers keep, exit, close or settle, and the box beats, ends, closes or releases as told.

import { z } from "zod";

/** How long a run's agent may sit at the end of its turn before the run is over: a run is briefed once. */
export const RUN_IDLE_BEFORE_EXIT_MS = 15 * 60_000;
/** How long a running turn, or a lead awaiting a child, may write nothing before the run is over. */
export const RUN_SILENT_BEFORE_EXIT_MS = 60 * 60_000;
/** How long a declaration may stand bound to no subagent and no process before it is ended. */
export const RUN_UNBOUND_BEFORE_END_MS = 60 * 60_000;
/** How long a run no master answers for may stand with its session over and its subagent silent before it is released. */
export const RUN_UNANSWERED_RELEASE_AFTER_MS = 60 * 60_000;

const AGE_MAX = 10 * 365 * 24 * 60 * 60_000;
const age = z.number().int().min(0).max(AGE_MAX);
const count = z.number().int().min(0).max(1000);

/** What the run's own session last reported about itself through its hooks. */
export const RUN_DOINGS = [
	"working",
	"awaiting_permission",
	"awaiting_children",
	"idle",
] as const;

/** How the master pane read when the process a subagent ran in was read gone. */
export const RUN_HOST_ENDS = [
	"pane_gone",
	"pane_started",
	"process_gone",
] as const;
export type RunHostEnd = (typeof RUN_HOST_ENDS)[number];

/**
 * What a subagent's own evidence says, read with no bound: `no_turn_end` it has ended no turn since
 * its run was declared; `host_ended` the process it ran in was read gone with nothing heard since;
 * `resumed` an entry after its last turn-end is a turn's own; `awaiting_reply` it was handed an entry
 * after its last turn-end and has written no reply; `turn_ended` it ended a turn and wrote nothing
 * after; `unreadable` its transcript cannot say what followed a turn-end; `tail_unreadable` its
 * transcript was written after a turn-end and cannot be opened to say what. Whether a silence is
 * long enough to call it over is core's (`devices/run-verdict.ts:subagentOver`).
 */
export const RUN_SUBAGENT_EVIDENCE = [
	"no_turn_end",
	"host_ended",
	"resumed",
	"awaiting_reply",
	"turn_ended",
	"unreadable",
	"tail_unreadable",
] as const;
export type RunSubagentEvidence = (typeof RUN_SUBAGENT_EVIDENCE)[number];

/** A subagent's evidence and how long it has been silent since it; `silentMs` is null for `unreadable`. */
export const runSubagentSchema = z.strictObject({
	kind: z.enum(RUN_SUBAGENT_EVIDENCE),
	silentMs: age.nullable(),
});
export type RunSubagent = z.infer<typeof runSubagentSchema>;

export const runFactsSchema = z.strictObject({
	/** The issue keys the ledger says this run holds, as the box declared them. */
	issueKeys: z.array(z.string().trim().min(1).max(64)).max(16),
	/** Whether the run is parked on a question only a person answers. */
	parkedOnHuman: z.boolean(),
	/** The master pane that declared the run, as tmux answered for it. */
	master: z.enum(["alive", "gone", "unknown", "unanswered"]),
	/** Whether another live master pane on this box answers for the run's project. */
	liveMasterInProject: z.boolean(),
	/** Whether the run was declared under this boot. */
	thisBoot: z.boolean(),
	/**
	 * Whether the boot the run was declared under is known to have ended: the box read its own boot
	 * and the run's, and they differ. A box that cannot read its boot says false, which ends nothing.
	 */
	bootEnded: z.boolean(),
	/** Whether a subagent bound the declaration with its first hook. */
	bound: z.boolean(),
	/** The run's own process: none recorded, alive, or read gone. */
	process: z.enum(["none", "alive", "gone"]),
	/** Whether the ledger's own incarnation and pid read the run dead. */
	ledgerDead: z.boolean(),
	/** The Claude Code process a subagent ran in, where one is recorded and was read this sweep. */
	host: z.enum(["not_read", "alive", "gone", "unreadable"]),
	/** That process read gone with nothing heard from its subagent since, and how its master pane read then. */
	hostEnded: z.enum(RUN_HOST_ENDS).nullable(),
	/** Whether the ledger already records who ended the run. */
	ended: z.boolean(),
	/** How long ago the run was declared, by the box's clock. */
	declaredAgoMs: age,
	/** Whether git no longer registers the run's checkout; null where it was not asked. */
	checkoutGone: z.boolean().nullable(),
	/** Whether the run has a session at core to beat or close. */
	hasSession: z.boolean(),
	/** What the run's session last reported, or null where it has reported nothing in this daemon. */
	activity: z
		.strictObject({
			doing: z.enum(RUN_DOINGS),
			lastEventAgoMs: age,
			/** Since the newest write to its own transcript; null where none can be read. */
			writtenAgoMs: age.nullable(),
		})
		.nullable(),
	/** How long ago an earlier sweep first read the session over at core; null while it is not. */
	sessionOverForMs: age.nullable(),
	/** What the subagent's own evidence says, read by the box with no bound. */
	subagent: runSubagentSchema,
	/** The subagent's own transcript: none recorded, unreadable, or written so long ago. */
	transcript: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("none") }),
		z.strictObject({ kind: z.literal("unreadable") }),
		z.strictObject({ kind: z.literal("written"), agoMs: age }),
	]),
	/** Whether a release of this run was decided terminal, so its checkout stays by decision. */
	releaseDecided: z.boolean(),
	/** Whether a release of this run is in a refusal streak. */
	releaseRefused: z.boolean(),
	/** The close loop's marks read back after this sweep's close; null before the box has closed it. */
	close: z
		.strictObject({
			sessionTerminal: z.boolean(),
			checkoutReturned: z.boolean(),
			leasesReturned: count,
			leasesTotal: count,
		})
		.nullable(),
});
export type RunFacts = z.infer<typeof runFactsSchema>;

export const runVerdictRequestSchema = z.strictObject({
	projectId: z.uuid().nullable(),
	facts: runFactsSchema,
});
export const RUN_VERDICT_SHAPE =
	"{ projectId: uuid | null, facts: { issueKeys, parkedOnHuman, master, liveMasterInProject, thisBoot, bootEnded, bound, process, ledgerDead, host, hostEnded, ended, declaredAgoMs, checkoutGone, hasSession, activity, sessionOverForMs, subagent, transcript, releaseDecided, releaseRefused, close } } — see @forge/contracts/run-verdict runFactsSchema";

/** Why a run the close loop could not finish this sweep still stands. */
export const RUN_STANDINGS = [
	"unanswered",
	"foreign_boot",
	"decided",
	"awaiting_core",
] as const;
export type RunStanding = (typeof RUN_STANDINGS)[number];

/** Why a run's agent is over while its process still runs. */
export const RUN_EXIT_CAUSES = [
	"idle",
	"children_silent",
	"lead_silent",
] as const;
export type RunExitCause = (typeof RUN_EXIT_CAUSES)[number];

/** What a release says first, once: the silence it rests on, or the host process it ended with. */
export type RunReleaseNotice =
	| { kind: "unanswered"; overMs: number }
	| { kind: "host"; how: RunHostEnd };

/**
 * `keep`: the box holds the run; `beat` asserts that at core, `reparent` moves a parked run onto the
 * project's live master, `sayKept` has the box say once why a finished-looking subagent is kept.
 * `exit`: the run's agent is over; the box ends its process and closes its session with `because`.
 * `close`: the run is orphaned; the box ends it in its ledger first where `end` names why, runs its
 * close loop, and asks again with the marks read back. `settle`: what the close loop left owed.
 */
export type RunVerdict =
	| {
			act: "keep";
			beat: boolean;
			reparent: boolean;
			sayKept: boolean;
			because: string;
	  }
	| { act: "exit"; cause: RunExitCause; because: string }
	| { act: "close"; end: string | null; because: string }
	| {
			act: "settle";
			release: { reason: string; notice: RunReleaseNotice | null } | null;
			deathReport: boolean;
			standing: RunStanding | null;
			releaseAfterMinutes: number;
			because: string;
	  };
export type RunVerdictAct = RunVerdict["act"];
