// How a project's resident master works its backlog (owner, 2026-10-30). A project that runs fast — gate
// profile `yolo` and fast delivery on — has its master build directly and record afterwards: no
// dispatched runner, no generated brief, no plan approval, design record or judge before landing. Every
// other project's master dispatches each issue to a shipped role, as before.
//
// The mode is read from what the project already declares, never from a switch of its own: the profile
// says no policy gate asks a plan, a design, a review or a judge before a merge, and fast delivery says a
// change lands on build and its own tests. A profile Forge raised after an incident is no longer `yolo`,
// so the raise takes the project out of direct mode with it. The kernel is not the mode's to relax:
// `KERNEL_RULES` holds whichever way the master works.

import { fastDeliveryOf } from "./delivery-policy.js";
import { type GatesConfig, gateProfileOf } from "./gate-profiles.js";

export const MASTER_MODES = ["dispatch", "direct"] as const;
export type MasterMode = (typeof MASTER_MODES)[number];

/** What of a project document decides the mode. */
export interface MasterModeSources {
	readonly gates?: GatesConfig | null | undefined;
	readonly delivery?: { readonly fast?: boolean | undefined } | null | undefined;
}

/** `direct` where the profile is `yolo` and the project delivers fast; `dispatch` everywhere else. */
export function masterModeOf(document: MasterModeSources | null | undefined): MasterMode {
	const yolo = gateProfileOf(document?.gates) === "yolo";
	return yolo && fastDeliveryOf(document?.delivery) ? "direct" : "dispatch";
}
