// The gates a gated move asks (REQ-34 BC-8, BC-9): one list for the kernel that records each move
// against them and the report that counts them. A gate is a registered checklist, which the edge
// asking it names (`checklist-registry.ts:CHECKLISTS`), or a move check: one of the edge's guards
// whose refusal codes are the check's own. A checklist added to an edge is a gate with no change
// here; a check is declared below, and `defineMoveChecks` refuses at load one naming an edge or a
// guard its machine does not have.

import { CHECKLISTS } from "./checklist-registry.js";
import { CHECKLIST_GUARD } from "./checklists.js";
import { DESIGN_RECORD_INCOMPLETE, DESIGN_RECORD_MISSING } from "./issue-design.js";
import { MACHINES, type MachineEntity } from "./machines.js";
import { PATTERN_ENTRY_MISSING, PATTERN_RETURNED, PATTERN_REVIEW_PENDING } from "./patterns.js";
import type { MachineEdge } from "./state-machine.js";

/** The edges a gate is asked on: one machine, these statuses, into one status. */
export interface GateEdges {
	readonly machine: string;
	readonly from: readonly string[];
	readonly to: string;
}

export interface Gate {
	readonly id: string;
	readonly title: string;
	readonly version: number;
	readonly kind: "checklist" | "check";
	readonly gates: GateEdges;
}

/** A check one guard of an edge runs: its refusals with these codes are this gate's, and no other. */
export interface MoveCheck {
	readonly id: string;
	readonly title: string;
	readonly version: number;
	readonly gates: GateEdges;
	readonly guard: string;
	readonly codes: readonly string[];
}

function lifecycleEdge(gates: GateEdges, from: string): MachineEdge | undefined {
	const machine = MACHINES[gates.machine as MachineEntity] as
		| { edges: readonly MachineEdge[] }
		| undefined;
	return machine?.edges.find((e) => e.from === from && e.to === gates.to && e.recovery !== true);
}

export function defineMoveChecks<const C extends readonly MoveCheck[]>(checks: C): C {
	const seen = new Set<string>(Object.keys(CHECKLISTS));
	for (const check of checks) {
		if (seen.has(check.id)) {
			throw new Error(`move check \`${check.id}\`: the id is already a checklist's or another check's`);
		}
		seen.add(check.id);
		if (check.codes.length === 0) throw new Error(`move check \`${check.id}\` names no refusal code`);
		for (const from of check.gates.from) {
			const edge = lifecycleEdge(check.gates, from);
			const move = `${check.gates.machine} \`${from}\` → \`${check.gates.to}\``;
			if (!edge) throw new Error(`move check \`${check.id}\`: ${move} is not an edge of its machine`);
			if (!edge.guards.includes(check.guard)) {
				throw new Error(`move check \`${check.id}\`: ${move} does not name guard \`${check.guard}\``);
			}
		}
	}
	return checks;
}

/** The move checks the kernel records today. */
export const MOVE_CHECKS = defineMoveChecks([
	{
		id: "design_record",
		title: "Design record",
		version: 1,
		gates: { machine: "issue", from: ["in_progress"], to: "approved" },
		guard: "design",
		codes: [DESIGN_RECORD_MISSING, DESIGN_RECORD_INCOMPLETE],
	},
	{
		id: "patterns",
		title: "Patterns",
		version: 1,
		gates: { machine: "issue", from: ["in_progress"], to: "awaiting_release" },
		guard: "merged",
		codes: [PATTERN_REVIEW_PENDING, PATTERN_RETURNED, PATTERN_ENTRY_MISSING],
	},
] as const);

/** Every gate: each registered checklist, then each move check. */
export const GATES: readonly Gate[] = [
	...Object.values(CHECKLISTS).map(
		(c): Gate => ({ id: c.id, title: c.title, version: c.version, kind: "checklist", gates: c.gates }),
	),
	...MOVE_CHECKS.map(
		(c): Gate => ({ id: c.id, title: c.title, version: c.version, kind: "check", gates: c.gates }),
	),
];

const asks = (gates: GateEdges, entity: string, edge: MachineEdge): boolean =>
	gates.machine === entity && gates.from.includes(edge.from) && gates.to === edge.to;

/**
 * The gates a move along this edge is judged by: the checklist it names, and each check bound to one
 * of its guards. A recovery edge asks none, whatever statuses it joins.
 */
export function edgeGates(entity: string, edge: MachineEdge): Gate[] {
	if (edge.recovery === true) return [];
	const checks = new Set<string>(
		MOVE_CHECKS.filter((c) => asks(c.gates, entity, edge) && edge.guards.includes(c.guard)).map(
			(c) => c.id,
		),
	);
	return GATES.filter((g) => (g.kind === "checklist" ? g.id === edge.checklist : checks.has(g.id)));
}

/**
 * The gate a guard's refusal on this edge is: the edge's checklist for the checklist guard, else the
 * check bound to that guard whose codes hold the refusal's. Null where no gate refused: a permission,
 * a holder, a merge not recorded.
 */
export function refusingGate(
	entity: string,
	edge: MachineEdge,
	guard: string,
	code: string,
): Gate | null {
	const gates = edgeGates(entity, edge);
	if (guard === CHECKLIST_GUARD) return gates.find((g) => g.kind === "checklist") ?? null;
	const check = MOVE_CHECKS.find(
		(c) => c.guard === guard && (c.codes as readonly string[]).includes(code),
	);
	return check ? (gates.find((g) => g.id === check.id) ?? null) : null;
}

/**
 * How a gated move stands against its gate. `exception`: the item reached the gate's status without
 * the gate judging it, born there after the gate first judged a move. `no_checklist`: recorded before
 * the kernel recorded that gate. Only `passed` counts as passing (BC-9).
 */
export const GATED_MOVE_STANDINGS = ["passed", "refused", "exception", "no_checklist"] as const;
export type GatedMoveStanding = (typeof GATED_MOVE_STANDINGS)[number];

export const countsAsPassed = (standing: GatedMoveStanding): boolean => standing === "passed";

/**
 * A passed move along the gate's statuses, as `kernel_transitions` recorded it: `checklist` and
 * `gates` are null on a row recorded before each existed. Null where the move did not ask this gate
 * (a recovery edge between the same statuses): it is no gated move of it.
 */
export function passedMoveStanding(
	gate: Pick<Gate, "id">,
	move: { readonly checklist: string | null; readonly gates: readonly string[] | null },
): GatedMoveStanding | null {
	if (move.checklist === gate.id || move.gates?.includes(gate.id) === true) return "passed";
	return move.gates === null ? "no_checklist" : null;
}

/** An item born at the gate's status: past the gate once it judged anything, before then never asked. */
export function birthStanding(bornAt: Date, gateSince: Date | null): GatedMoveStanding {
	return gateSince !== null && bornAt >= gateSince ? "exception" : "no_checklist";
}
