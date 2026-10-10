/** Every word the Runners page uses to name a scope or a count, so a claim it
 *  makes can be proved without rendering it (ISS-1162). */

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

/** What the org list says in place of the owner's controls. */
export function rowActionNote(scope: DeviceScope, ownedByMe: boolean, t: Copy): string | null {
	if (scope === "mine") return null;
	return ownedByMe ? t("runners.scope.yours") : t("runners.scope.readOnly");
}

/** What an empty list reads as: one or two words naming the scope's absence (REQ-43 BC-6). */
export function emptyTitle(scope: DeviceScope, t: Copy): string {
	return scope === "mine" ? t("runners.scope.emptyMine") : t("runners.scope.emptyOrg");
}
