// The runner and device machines: a box's liveness and its provisioning. No state design is
// drawn for them.

import { defineMachine, fromEach } from "./state-machine.js";

export const RUNNER_STATUSES = ["online", "offline", "draining", "disabled"] as const;
export const RUNNER_MACHINE = defineMachine({
	entity: "runner",
	shapes: ["403a0154"],
	design: null,
	states: RUNNER_STATUSES,
	initial: ["online", "offline"],
	terminal: [],
	reasonRequired: [],
	edges: [
		...fromEach(["offline", "draining"] as const, "online", { act: "runner.connected", permission: null, guards: [] }),
		...fromEach(["online", "draining", "disabled"] as const, "offline", { act: "runner.disconnected", permission: null, guards: [] }),
		...fromEach(["online", "offline"] as const, "draining", { act: "runner.draining", permission: "runners.write", guards: [] }),
		...fromEach(["online", "offline", "draining"] as const, "disabled", { act: "runner.disabled", permission: "runners.write", guards: [] }),
	],
});

export const RUNNER_PROVISION_STATUSES = [
	"queued",
	"cloning",
	"syncing_skills",
	"writing_mcp",
	"ready",
	"needs_manual_setup",
	"failed",
] as const;
/** A box reports its provisioning step by step; any report may follow any other, since a box
 *  provisions again after a reset. */
export const RUNNER_PROVISION_MACHINE = defineMachine({
	entity: "runner_provision",
	shapes: ["b2460212"],
	design: null,
	states: RUNNER_PROVISION_STATUSES,
	initial: ["queued"],
	terminal: [],
	reasonRequired: [],
	edges: RUNNER_PROVISION_STATUSES.flatMap((to) =>
		fromEach(RUNNER_PROVISION_STATUSES, to, { act: `provision.${to}`, permission: null, guards: [] }),
	),
});

export const DEVICE_STATUSES = ["online", "offline", "revoked"] as const;
export const DEVICE_MACHINE = defineMachine({
	entity: "device",
	shapes: ["9c512d74"],
	design: null,
	states: DEVICE_STATUSES,
	initial: ["offline"],
	terminal: ["revoked"],
	reasonRequired: [],
	edges: [
		{ from: "offline", to: "online", act: "device.connected", permission: null, guards: [] },
		{ from: "online", to: "offline", act: "device.disconnected", permission: null, guards: [] },
		...fromEach(["online", "offline"] as const, "revoked", { act: "device.revoked", permission: "devices.write", guards: [] }),
	],
});
