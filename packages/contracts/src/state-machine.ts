// A status machine as data (pattern v2, BC-17): the states a status column holds and the moves
// between them. Core's one kernel transition (`packages/core/src/lifecycle/transition.ts:transition`)
// writes a status only along an edge declared here; the column's CHECK holds the same `states`.

import { CHECKLISTS, isChecklistId } from "./checklist-registry.js";
import { CHECKLIST_GUARD } from "./checklists.js";
import { fingerprint } from "./fingerprint.js";
import type { Refusal, RefusalStatuses } from "./refusal.js";

/** One move. `act` is the edge's name in its design; `permission` is what `can()` asks of the
 *  actor, null where only the kernel itself moves it; `guards` name the checks core runs on the row
 *  before the write, in order. A `recovery` edge is taken only by the explicit recovery move. An
 *  edge naming the `checklist` guard names the checklist the kernel runs there
 *  (`checklist-registry.ts:CHECKLISTS`). */
export interface MachineEdge<S extends string = string> {
	readonly from: S;
	readonly to: S;
	readonly act: string;
	readonly permission: string | null;
	readonly guards: readonly string[];
	readonly recovery?: true;
	readonly checklist?: string;
}

export interface StatusMachine<
	E extends string = string,
	S extends string = string,
> {
	/** The `kernel_transitions.entity` a move of this machine is recorded under. */
	readonly entity: E;
	/** The machine's version: the number of shapes it has had, recorded on every
	 *  `kernel_transitions` row as the version that judged the move. Never reused. */
	readonly version: number;
	/** The fingerprint of each shape the machine has had, oldest first; the last one is the shape
	 *  declared now. A change to its states or edges appends one, which is the version bump. */
	readonly shapes: readonly string[];
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

/** What a machine file declares; `defineMachine` derives its `version` from `shapes`. */
type MachineDeclaration<E extends string, S extends string> = Omit<
	StatusMachine<E, S>,
	"version"
>;

/** The fingerprint of the machine's states and edges: what its `shapes` record. */
function machineShape(machine: MachineDeclaration<string, string>): string {
	return fingerprint(
		JSON.stringify([
			machine.states,
			machine.initial,
			machine.terminal,
			machine.reasonRequired,
			machine.edges.map((e) => {
				const edge = [e.from, e.to, e.act, e.permission, e.guards, e.recovery === true];
				return e.checklist === undefined ? edge : [...edge, e.checklist];
			}),
		]),
	);
}

/** The `checklist` guard and the checklist an edge names go together, and the checklist gates it. */
function checklistFaults(machine: MachineDeclaration<string, string>): string[] {
	const faults: string[] = [];
	for (const e of machine.edges) {
		const move = `\`${e.from}\` → \`${e.to}\``;
		const guarded = e.guards.includes(CHECKLIST_GUARD);
		if (guarded !== (e.checklist !== undefined)) {
			faults.push(
				guarded
					? `${move} names the checklist guard and no checklist`
					: `${move} names checklist \`${e.checklist}\` without the checklist guard`,
			);
			continue;
		}
		if (e.checklist === undefined) continue;
		if (!isChecklistId(e.checklist)) {
			faults.push(`${move} names checklist \`${e.checklist}\`, which is not registered`);
			continue;
		}
		const gates = CHECKLISTS[e.checklist].gates;
		if (gates.machine !== machine.entity || !gates.from.includes(e.from) || gates.to !== e.to) {
			faults.push(
				`${move} names checklist \`${e.checklist}\`, which gates ${gates.machine} ${gates.from.map((f) => `\`${f}\``).join(", ")} → \`${gates.to}\``,
			);
		}
	}
	return faults;
}

/**
 * Declares a machine, refusing at load any edge that names a state the machine does not hold, and
 * a shape that is not the last one its `shapes` records: a changed machine is a new version.
 */
export function defineMachine<const E extends string, const S extends string>(
	machine: MachineDeclaration<E, S>,
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
	const faults = checklistFaults(machine);
	if (faults.length > 0) {
		throw new Error(`machine \`${machine.entity}\`: ${faults.join("; ")}`);
	}
	const shape = machineShape(machine);
	if (machine.shapes.at(-1) !== shape) {
		throw new Error(
			`machine \`${machine.entity}\` has states or edges that no version records: its shape is now ${shape}, and its last recorded shape is ${machine.shapes.at(-1) ?? "none"}. Append "${shape}" to its \`shapes\` (version ${machine.shapes.length + 1}); a change that removes a state or an edge ships the declared migration that moves its rows (docs/patterns/core-module.md, Status machines).`,
		);
	}
	return { ...machine, version: machine.shapes.length };
}

/** Edges from every listed state to `to`, for a move drawn once "from any of these". */
export function fromEach<S extends string>(
	from: readonly S[],
	to: S,
	edge: Omit<MachineEdge<S>, "from" | "to">,
): MachineEdge<S>[] {
	return from.filter((f) => f !== to).map((f) => ({ ...edge, from: f, to }));
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

const STATE_MACHINE_REFUSAL_CODES = [
	"TRANSITION_NOT_AN_EDGE",
	"TRANSITION_REASON_REQUIRED",
	"STALE_TRANSITION",
] as const;
type StateMachineRefusalCode = (typeof STATE_MACHINE_REFUSAL_CODES)[number];
export const STATE_MACHINE_REFUSAL_STATUSES = {
	STALE_TRANSITION: 409,
} as const satisfies RefusalStatuses<StateMachineRefusalCode>;

/** A lost compare-and-set: the row left the status the caller read before the move took it. */
export function staleTransitionRefusal<S extends string>(
	machine: StatusMachine<string, S>,
	id: string,
	expected: S,
	actual: string,
	to: S,
	path = "/status",
): Refusal & { code: "STALE_TRANSITION"; id: string; expected: S; actual: string; to: S } {
	return {
		code: "STALE_TRANSITION",
		path,
		detail: `${machine.entity} ${id} was expected at \`${expected}\` for the move to \`${to}\`, and another writer moved it to \`${actual}\` first. Re-read it and decide whether the move still stands.`,
		id,
		expected,
		actual,
		to,
	};
}

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
