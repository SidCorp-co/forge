// The agent-session machine. No state design is drawn for sessions; `agent-run-standing`
// (approved revision 1) reads a run session's standing from it.

import { defineMachine, fromEach } from "./state-machine.js";

export const AGENT_SESSION_STATUSES = [
	"idle",
	"queued",
	"running",
	"completed",
	"failed",
	"completed_via_recovery",
	"cancelled_stale",
	"cancelled",
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

/** Still the runner's: working, waiting to work, or between turns. */
export const LIVE_SESSION_STATUSES: readonly AgentSessionStatus[] = ["queued", "running", "idle"];

/** `completed_via_recovery` and `cancelled_stale` end a session without failing it. */
export const TERMINAL_AGENT_SESSION_STATUSES = [
	"completed",
	"failed",
	"completed_via_recovery",
	"cancelled_stale",
	"cancelled",
] as const satisfies readonly AgentSessionStatus[];

/** The ends that stop a session on purpose rather than finish or fail it. */
export const CANCELLED_AGENT_SESSION_STATUSES: readonly AgentSessionStatus[] = [
	"cancelled",
	"cancelled_stale",
];

const ENDED: readonly AgentSessionStatus[] = TERMINAL_AGENT_SESSION_STATUSES;
const move = (act: string) => ({ act, permission: null, guards: [] as const });

export const SESSION_MACHINE = defineMachine({
	entity: "session",
	shapes: ["b4779e31"],
	design: null,
	states: AGENT_SESSION_STATUSES,
	initial: ["idle", "queued", "running"],
	terminal: ENDED,
	reasonRequired: [],
	edges: [
		...fromEach<AgentSessionStatus>(["idle", "running"], "queued", move("turn.queued")),
		...fromEach<AgentSessionStatus>(["idle", "queued"], "running", move("turn.started")),
		...fromEach<AgentSessionStatus>(["queued", "running"], "idle", move("turn.ended")),
		...ENDED.flatMap((to) => fromEach(LIVE_SESSION_STATUSES, to, move(`session.${to}`))),
		// A chat session takes another turn after it ended, and a worker revives a session a sweep
		// failed; a user-cancelled session is refused before it reaches here.
		...ENDED.flatMap((from) => [
			{ from, to: "queued" as const, ...move("session.revived") },
			{ from, to: "running" as const, ...move("session.revived") },
		]),
		// The job outcome sync, the recovery verifier and a late completion correct an ended outcome.
		...ENDED.flatMap((to) => fromEach(ENDED, to, move("outcome.corrected"))),
	],
});
