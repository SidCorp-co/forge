/** Every sentence the Runners page uses to state a population or a count, so a
 *  claim it makes can be proved without rendering it (ISS-1162). */

export type DeviceScope = "mine" | "org";

/** A count the screen does not have yet — not zero, which nothing measured. */
export const UNKNOWN_COUNT = "unknown" as const;
export type DeviceCount = number | typeof UNKNOWN_COUNT;

export const SCOPES: DeviceScope[] = ["mine", "org"];

export function scopeName(scope: DeviceScope): string {
	return scope === "mine" ? "Mine" : "Organisation";
}

/** The count beside a scope's name, always saying what is being counted. */
export function scopeCountLabel(count: DeviceCount): string {
	if (count === UNKNOWN_COUNT) return "counting…";
	return count === 1 ? "1 device" : `${count} devices`;
}

/** The prose under the card title: which population the rows below are. */
export function populationLine(scope: DeviceScope): string {
	return scope === "mine"
		? "Every device you have paired, including one that serves no project yet."
		: "Every device assigned to a project you can see in this organisation, whoever paired it, and every device this organisation's agents hold.";
}

/** Reconciles this page's device count with the Overview's runner count. */
export function assignmentBridgeLine(
	deviceCount: DeviceCount,
	runnerAssignments: DeviceCount,
): string | null {
	if (deviceCount === UNKNOWN_COUNT || runnerAssignments === UNKNOWN_COUNT) return null;
	if (deviceCount === 0) return null;
	// One device serves its assignments alone, so "between them" is said of two or more (ISS-1229 r24).
	const boxes = deviceCount === 1 ? "This device serves" : `These ${deviceCount} devices serve`;
	const assignments =
		runnerAssignments === 0
			? "no runner assignments"
			: runnerAssignments === 1
				? "1 runner assignment"
				: `${runnerAssignments} runner assignments`;
	const shared = deviceCount > 1 && runnerAssignments > 0 ? " between them" : "";
	return `${boxes} ${assignments}${shared} — the assignments are what Overview counts as runners.`;
}

/** What the org list says in place of the owner's controls; null where the row carries controls. */
export function rowActionNote(
	scope: DeviceScope,
	ownedByMe: boolean,
	canRevoke = false,
): string | null {
	if (scope === "mine") return null;
	if (ownedByMe) return "yours — manage it under Mine";
	return canRevoke ? null : "read only";
}

/** Who a box on the org list belongs to, where the viewer did not pair it. */
export function pairedByLabel(heldBy: string | null | undefined): string {
	return heldBy ? `held by the agent ${heldBy}` : "paired by another member";
}

export interface ScopeEmptyState {
	title: string;
	message: string;
}

/** Why this list is empty. The other scope's count is quoted only once known:
 *  "your organisation runs 0" in flight states a zero nothing measured. */
export function emptyState(
	scope: DeviceScope,
	counts: { mine: DeviceCount; org: DeviceCount },
): ScopeEmptyState {
	if (scope === "mine") {
		const org = counts.org;
		if (org === UNKNOWN_COUNT) {
			return {
				title: "You have not paired any machines",
				message: "Pair a runner with the command above, then assign it to a project.",
			};
		}
		if (org === 0) {
			return {
				title: "You have not paired any machines",
				message:
					"Pair a runner with the command above, then assign it to a project. No device is assigned to a project you can see in this organisation either.",
			};
		}
		return {
			title: "You have not paired any machines",
			message: `Your organisation runs ${scopeCountLabel(org)} on projects you can see — open the Organisation scope to read them.`,
		};
	}

	const mine = counts.mine;
	if (mine !== UNKNOWN_COUNT && mine > 0) {
		return {
			title: "No device is assigned to a project you can see in this organisation, and none of its agents holds one",
			message: `You have paired ${scopeCountLabel(mine)}. Assign one to a project in this organisation to see it here.`,
		};
	}
	return {
		title: "No device is assigned to a project you can see in this organisation, and none of its agents holds one",
		message:
			"Pair a runner with the command above, then assign it to a project in this organisation.",
	};
}
