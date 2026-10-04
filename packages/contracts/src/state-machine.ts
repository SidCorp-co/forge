// A status machine as data (pattern v2, BC-17): the states a status column holds and the moves
// between them. Core's one kernel transition (`packages/core/src/lifecycle/transition.ts:transition`)
// writes a status only along an edge declared here; the column's CHECK holds the same `states`.

import type { Refusal } from "./refusal.js";

/** One move. `act` is the edge's name in its design; `permission` is what `can()` asks of the
 *  actor, null where only the kernel itself moves it; `guards` name the checks core runs on the row
 *  before the write, in order. A `recovery` edge is taken only by the explicit recovery move. */
export interface MachineEdge<S extends string = string> {
	readonly from: S;
	readonly to: S;
	readonly act: string;
	readonly permission: string | null;
	readonly guards: readonly string[];
	readonly recovery?: true;
}

export interface StatusMachine<
	E extends string = string,
	S extends string = string,
> {
	/** The `kernel_transitions.entity` a move of this machine is recorded under. */
	readonly entity: E;
	/** The approved state design this machine is checked against, or null where none is drawn. */
	readonly design: { readonly flow: string; readonly revision: number } | null;
	readonly states: readonly S[];
	/** The states a row is created at. */
	readonly initial: readonly S[];
	readonly terminal: readonly S[];
	/** Entering one of these carries a reason from the actor. */
	readonly reasonRequired: readonly S[];
	readonly edges: readonly MachineEdge<S>[];
}

/** Declares a machine, refusing at load any edge that names a state the machine does not hold. */
export function defineMachine<const E extends string, const S extends string>(
	machine: StatusMachine<E, S>,
): StatusMachine<E, S> {
	const known = new Set<string>(machine.states);
	const named = [
		...machine.initial,
		...machine.terminal,
		...machine.reasonRequired,
		...machine.edges.flatMap((e) => [e.from, e.to]),
	];
	const unknown = named.filter((s) => !known.has(s));
	if (unknown.length > 0) {
		throw new Error(
			`machine \`${machine.entity}\` names ${[...new Set(unknown)].join(", ")}, which are not among its states (${machine.states.join(", ")})`,
		);
	}
	return machine;
}

/** Edges from every listed state to `to`, for a move drawn once "from any of these". */
export function fromEach<S extends string>(
	from: readonly S[],
	to: S,
	edge: Omit<MachineEdge<S>, "from" | "to">,
): MachineEdge<S>[] {
	return from.filter((f) => f !== to).map((f) => ({ ...edge, from: f, to }));
}

export function isStateOf<S extends string>(
	machine: StatusMachine<string, S>,
	value: string,
): value is S {
	return (machine.states as readonly string[]).includes(value);
}

/** The edge `from → to`; a recovery edge only when `recovery` is asked for, a lifecycle edge otherwise. */
export function edgeBetween<S extends string>(
	machine: StatusMachine<string, S>,
	from: S,
	to: S,
	recovery = false,
): MachineEdge<S> | null {
	const matching = machine.edges.filter((e) => e.from === from && e.to === to);
	if (recovery) return matching.find((e) => e.recovery) ?? null;
	return matching.find((e) => !e.recovery) ?? null;
}

/** The lifecycle moves out of `from`, in declaration order, each status once. */
export function exitsOf<S extends string>(
	machine: StatusMachine<string, S>,
	from: S,
	recovery = false,
): S[] {
	const out: S[] = [];
	for (const e of machine.edges) {
		if (e.from !== from || Boolean(e.recovery) !== recovery) continue;
		if (!out.includes(e.to)) out.push(e.to);
	}
	return out;
}

/** The states a move into `to` may start from. */
export function entriesOf<S extends string>(
	machine: StatusMachine<string, S>,
	to: S,
	recovery = false,
): S[] {
	const out: S[] = [];
	for (const e of machine.edges) {
		if (e.to !== to || Boolean(e.recovery) !== recovery) continue;
		if (!out.includes(e.from)) out.push(e.from);
	}
	return out;
}

/** The exits of `from` that one guard decides. */
export function exitsGuardedBy<S extends string>(
	machine: StatusMachine<string, S>,
	from: S,
	guard: string,
): S[] {
	return machine.edges
		.filter((e) => e.from === from && e.guards.includes(guard))
		.map((e) => e.to);
}

/** Every guard name the machine's edges carry, each once. */
export function guardNamesOf(machine: StatusMachine): string[] {
	return [...new Set(machine.edges.flatMap((e) => e.guards))];
}

export const STATE_MACHINE_REFUSAL_CODES = [
	"TRANSITION_NOT_AN_EDGE",
	"TRANSITION_REASON_REQUIRED",
] as const;
export type StateMachineRefusalCode = (typeof STATE_MACHINE_REFUSAL_CODES)[number];

/** A move the machine does not draw, named with the moves it does. */
export function notAnEdgeRefusal<S extends string>(
	machine: StatusMachine<string, S>,
	from: S,
	to: S,
	path = "/status",
): Refusal & { code: "TRANSITION_NOT_AN_EDGE"; from: S; to: S; allowed: S[] } {
	const allowed = exitsOf(machine, from);
	const exits =
		allowed.length === 0
			? "none: it is final"
			: allowed.map((s) => `\`${s}\``).join(", ");
	return {
		code: "TRANSITION_NOT_AN_EDGE",
		path,
		detail: `${machine.entity} \`${from}\` → \`${to}\` is not a move of its machine. From \`${from}\` the moves are ${exits}.`,
		from,
		to,
		allowed,
	};
}
