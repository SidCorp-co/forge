// The edges a gate is asked on: one machine, these statuses, into one status or several. A checklist
// whose answers stand in for more than one way out of the same status names each target: the
// issue-ready checklist gates `draft` → `open` and `draft` → `in_progress`, its holder's own take
// (issue lifecycle r25, ISS-834).

/** The edges a gate is asked on: one machine, these statuses, into `to`. */
export interface GateEdges {
	readonly machine: string;
	readonly from: readonly string[];
	readonly to: string | readonly string[];
}

/** Every status the gate's edges lead into. */
export function gateTargets(gates: GateEdges): readonly string[] {
	return typeof gates.to === "string" ? [gates.to] : gates.to;
}

/** Whether the move `from` → `to` on `machine` is one of the gate's edges. */
export function gatesMove(
	gates: GateEdges,
	move: { readonly machine: string; readonly from: string | null; readonly to: string },
): boolean {
	return (
		gates.machine === move.machine &&
		move.from !== null &&
		gates.from.includes(move.from) &&
		gateTargets(gates).includes(move.to)
	);
}
