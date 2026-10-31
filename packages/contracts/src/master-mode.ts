// How a project's resident master works its backlog (owner, 2026-10-30; REQ-79 r6, 2026-10-31). A
// project that delivers fast and has not asked for human control (`strict`) has its master build
// directly and record afterwards: no dispatched runner, no generated brief, no plan approval, design
// record or judge before landing. A `strict` project's master dispatches each issue to a shipped role.
//
// The mode is read from what the project already declares, never from a switch of its own: fast
// delivery says a change lands on build and its own tests, and only `strict` asks a person or a
// separate judge before a merge. The kernel is not the mode's to relax: `KERNEL_RULES` holds whichever
// way the master works.

import { fastDeliveryOf } from "./delivery-policy.js";
import { type GatesConfig, gateProfileOf } from "./gate-profiles.js";

export const MASTER_MODES = ["dispatch", "direct"] as const;
export type MasterMode = (typeof MASTER_MODES)[number];

/** What of a project document decides the mode. */
export interface MasterModeSources {
	readonly gates?: GatesConfig | null | undefined;
	readonly delivery?: { readonly fast?: boolean | undefined } | null | undefined;
}

/** `direct` where the project delivers fast and is not `strict`; `dispatch` everywhere else. */
export function masterModeOf(document: MasterModeSources | null | undefined): MasterMode {
	const strict = gateProfileOf(document?.gates) === "strict";
	return !strict && fastDeliveryOf(document?.delivery) ? "direct" : "dispatch";
}
