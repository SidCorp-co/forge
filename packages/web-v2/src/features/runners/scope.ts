/** Every sentence the Runners page uses to state a population or a count, so a
 *  claim it makes can be proved without rendering it (ISS-1162). */

import type { Copy } from "@/lib/i18n/product-copy";

export type DeviceScope = "mine" | "org";

/** A count the screen does not have yet — not zero, which nothing measured. */
export const UNKNOWN_COUNT = "unknown" as const;
export type DeviceCount = number | typeof UNKNOWN_COUNT;

export const SCOPES: DeviceScope[] = ["mine", "org"];

export function scopeName(scope: DeviceScope, t: Copy): string {
	return t(`runners.scope.${scope}`);
}

/** The count beside a scope's name, always saying what is being counted. */
export function scopeCountLabel(count: DeviceCount, t: Copy): string {
	if (count === UNKNOWN_COUNT) return t("runners.scope.counting");
	return count === 1 ? t("runners.scope.oneDevice") : t("runners.scope.devices", { n: count });
}

/** The prose under the card title: which population the rows below are. */
export function populationLine(scope: DeviceScope, t: Copy): string {
	return t(`runners.scope.population.${scope}`);
}

/** Reconciles this page's device count with the Overview's runner count. */
export function assignmentBridgeLine(
	deviceCount: DeviceCount,
	runnerAssignments: DeviceCount,
	t: Copy,
): string | null {
	if (deviceCount === UNKNOWN_COUNT || runnerAssignments === UNKNOWN_COUNT) return null;
	if (deviceCount === 0) return null;
	const boxes = deviceCount === 1 ? t("runners.scope.bridgeOneDevice") : t("runners.scope.bridgeDevices", { n: deviceCount });
	const assignments = runnerAssignments === 1 ? t("runners.scope.oneAssignment") : t("runners.scope.assignments", { n: runnerAssignments });
	return t("runners.scope.bridge", { boxes, assignments });
}

/** What the org list says in place of the owner's controls. */
export function rowActionNote(scope: DeviceScope, ownedByMe: boolean, t: Copy): string | null {
	if (scope === "mine") return null;
	return ownedByMe ? t("runners.scope.yours") : t("runners.scope.readOnly");
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
	t: Copy,
): ScopeEmptyState {
	if (scope === "mine") {
		const org = counts.org;
		const title = t("runners.scope.emptyMine");
		if (org === UNKNOWN_COUNT) return { title, message: t("runners.scope.pairThenAssign") };
		if (org === 0) return { title, message: t("runners.scope.pairThenAssignNone") };
		return { title, message: t("runners.scope.orgRuns", { count: scopeCountLabel(org, t) }) };
	}

	const mine = counts.mine;
	const title = t("runners.scope.emptyOrg");
	if (mine !== UNKNOWN_COUNT && mine > 0) {
		return { title, message: t("runners.scope.youPaired", { count: scopeCountLabel(mine, t) }) };
	}
	return { title, message: t("runners.scope.pairThenAssignOrg") };
}
