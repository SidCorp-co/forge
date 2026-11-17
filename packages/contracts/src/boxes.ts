// Forge Box (ISS-1276; ADR 0015): a screen an agent tests a UI in, and a person watches, takes and
// hands back from Forge. A box is a kernel record core holds; the runner on a device only runs it
// (its `runner-box` crate) and reports what it measured. Core decides who holds a box, who views
// it, and when a request waits. This file is the record, its machine, the refusals, the doors, and
// the allocation's inputs; `./box-wire.ts` is what crosses to and from the runner and the viewer.
//
// "Box" here is the Forge Box, never the machine a runner runs on: that one is the device.

import { z } from "zod";
import { TUNNEL_BOX_FPS } from "./preview-tunnel.js";
import type { RefusalStatuses } from "./refusal.js";
import { defineMachine } from "./state-machine.js";

/** What a box shows: a web page, an Android emulator, or a Linux desktop app. */
export const BOX_MODES = ["browser", "android", "desktop"] as const;
export type BoxMode = (typeof BOX_MODES)[number];

/**
 * Modes a request or a runner may name that no box serves yet. Each is refused
 * `BOX_MODE_UNAVAILABLE` by name, never read as a typo (owner 2026-11-17: "cái ios từ đã").
 */
export const BOX_UNSERVED_MODES = ["ios"] as const;
export type BoxUnservedMode = (typeof BOX_UNSERVED_MODES)[number];

/**
 * `waiting`: asked for, and the device's health has no room for it yet (`BOX_SLOT_UNAVAILABLE`
 * names its place and why); core starts it when health returns. `opening`: the runner was told to
 * start it. `warm`: running and nobody's yet, kept so the next request of its mode starts at once.
 * `agent`: running, and the agent drives it. `person`: running, and a person holds it; the agent's
 * state-changing acts are refused `BOX_HELD_BY_PERSON`, its reads answer. `closed`: done, and its
 * processes reaped; its recording stays on the device until its issue ends. `failed`: it could not
 * start or stopped answering, with a `BoxFailure`.
 */
export const BOX_STATES = [
	"waiting",
	"opening",
	"warm",
	"agent",
	"person",
	"closed",
	"failed",
] as const;
export type BoxState = (typeof BOX_STATES)[number];

/** The states a box's processes run in: a viewer may enter, an act may reach it. */
export const BOX_RUNNING_STATES = [
	"warm",
	"agent",
	"person",
] as const satisfies readonly BoxState[];
/** The states that hold the device's headroom: running, or told to start. */
export const BOX_HOLDING_STATES = [
	"opening",
	"warm",
	"agent",
	"person",
] as const satisfies readonly BoxState[];

/**
 * The box's moves. `box.take` and `box.released` are a person's; `box.expired` is the kernel's, when a
 * person's hold went idle for `BOX_LIMITS.holdIdleSeconds`. `box.started` (waiting → opening) is
 * core's allocation, never a caller's. Every move is recorded with who made it and when, in
 * `kernel_transitions` (`entity: "box"`).
 */
export const BOX_MACHINE = defineMachine({
	entity: "box",
	shapes: ["0668fa16"],
	design: null,
	states: BOX_STATES,
	initial: ["waiting", "opening"],
	terminal: ["closed", "failed"],
	reasonRequired: ["failed"],
	edges: [
		{
			from: "waiting",
			to: "opening",
			act: "box.started",
			permission: null,
			guards: [],
		},
		{ from: "opening", to: "warm", act: "box.warm", permission: null, guards: [] },
		{ from: "opening", to: "agent", act: "box.ready", permission: null, guards: [] },
		{ from: "opening", to: "person", act: "box.ready", permission: null, guards: [] },
		{ from: "warm", to: "agent", act: "box.assigned", permission: null, guards: [] },
		{ from: "warm", to: "person", act: "box.assigned", permission: null, guards: [] },
		{
			from: "agent",
			to: "person",
			act: "box.take",
			permission: "project.write",
			guards: [],
		},
		{
			from: "person",
			to: "agent",
			act: "box.released",
			permission: "project.write",
			guards: [],
		},
		{ from: "person", to: "agent", act: "box.expired", permission: null, guards: [] },
		...(["waiting", "opening", "warm", "agent", "person"] as const).map(
			(from) => ({
				from,
				to: "closed" as const,
				act: "box.closed",
				permission: "project.write" as const,
				guards: [],
			}),
		),
		...(["opening", "warm", "agent", "person"] as const).map((from) => ({
			from,
			to: "failed" as const,
			act: "box.failed",
			permission: null,
			guards: [],
		})),
	],
});

/** Why a box failed, shown on its row. */
export const BOX_FAILURES = [
	/** The runner could not start the mode's tools; `detail` holds what it said. */
	"START_FAILED",
	/** The driver's stream port went away and no new one was found (agent-browser's restart). */
	"STREAM_LOST",
	/** The runner stopped reporting the box: its heartbeat no longer lists it. */
	"BOX_GONE",
	/** The device went offline past the grace period. */
	"DEVICE_OFFLINE",
] as const;
export type BoxFailure = (typeof BOX_FAILURES)[number];

export const BOX_LIMITS = {
	/** A person's hold with no input this long expires back to the agent, on the record. */
	holdIdleSeconds: 300,
	/** A viewer ticket is spent once within this. */
	ticketSeconds: 60,
	/** A watch-only viewer's default frame rate; each viewer names its own within the bounds. */
	viewFpsDefault: 10,
	viewFpsMin: TUNNEL_BOX_FPS.min,
	viewFpsMax: TUNNEL_BOX_FPS.max,
	/** How long an act's REST call waits for the runner's result before answering `pending`. */
	actWaitSeconds: 60,
	actArgs: 64,
	actArgChars: 4000,
	actStdoutBytes: 65_536,
	actStderrBytes: 16_384,
	/** A heartbeat's health older than this is not measured: a request waits for a fresh one. */
	healthFreshSeconds: 90,
	/** A box opening this long with no `ready` fails `START_FAILED`. */
	openTimeoutSeconds: 180,
	viewport: { minPx: 240, maxPx: 3840 },
	url: 2048,
	reason: 500,
} as const;

/** Who drives a box: the agent's run, or a person. Its wire form is `agent:<run>` / `person:<user>`. */
export type BoxHolder =
	| { kind: "agent"; runId: string | null }
	| { kind: "person"; userId: string; name: string | null };

export const holderKey = (h: BoxHolder): string =>
	h.kind === "agent" ? `agent:${h.runId ?? "unnamed"}` : `person:${h.userId}`;

/**
 * Where a waiting box stands: its place among the device's waiting requests (1 is next) and the
 * health reason it waits on, in words a person reads ("available memory 12 GB is under the 16 GB
 * reserve").
 */
export interface BoxQueuePlace {
	position: number;
	reason: string;
}

/** The record every door answers with. */
export interface BoxRecord {
	id: string;
	deviceId: string;
	/** Null for a warm box no project holds yet. */
	projectId: string | null;
	issueId: string | null;
	/** The criterion number under test, as the agent named it; core infers none. */
	criterion: number | null;
	mode: BoxMode;
	state: BoxState;
	holder: BoxHolder | null;
	/** When the current holder took it. */
	heldSince: string | null;
	queue: BoxQueuePlace | null;
	viewport: { width: number; height: number } | null;
	url: string | null;
	/** What the runner offered for viewing once ready (`./box-wire.ts` `BoxViewCodec`). */
	view: { codec: string; width: number; height: number } | null;
	recording: {
		state: "recording" | "kept" | "dropped";
		startedAt: string | null;
	} | null;
	failure: BoxFailure | null;
	detail: string | null;
	openedBy: string;
	createdAt: string;
	closedAt: string | null;
}

/** One act on a box: the agent's command, or the person's input, in the order the box got them. */
export interface BoxActRecord {
	id: string;
	boxId: string;
	seq: number;
	by: "agent" | "person";
	/** The run or the person, as `holderKey` writes it. */
	actor: string;
	kind: "read" | "write" | "input";
	/** The driver argv for an agent's act; for a person's input, its `BoxInput` as JSON. */
	command: string[];
	state: "pending" | "done" | "failed" | "refused";
	exitCode: number | null;
	stdout: string | null;
	stderr: string | null;
	durationMs: number | null;
	refusal: string | null;
	at: string;
}

/** A criterion's span on a box's recording, and the clip and still cut from it. */
export interface BoxSpanRecord {
	id: string;
	boxId: string;
	issueId: string;
	criterion: number;
	state: "open" | "cutting" | "attached" | "failed";
	startedAt: string;
	endedAt: string | null;
	/** The issue attachments the clip and its opening still became; cite them in a verdict. */
	clipAttachmentId: string | null;
	stillAttachmentId: string | null;
	detail: string | null;
}

/**
 * The first token of an agent's command names its verb. These read and change nothing, so they answer
 * while a person holds the box; every other verb is a write. A verb a driver adds is a write until it
 * is listed here: the list fails closed.
 */
export const BOX_READ_VERBS = {
	browser: ["snapshot", "get", "is", "screenshot", "wait", "console", "errors"],
	android: ["snapshot", "get", "is", "screenshot", "wait", "logs"],
	desktop: ["snapshot", "get", "is", "screenshot", "wait"],
} as const satisfies Record<BoxMode, readonly string[]>;

export function actKindOf(mode: BoxMode, command: readonly string[]): "read" | "write" {
	const verb = command[0] ?? "";
	return (BOX_READ_VERBS[mode] as readonly string[]).includes(verb)
		? "read"
		: "write";
}

const viewportSchema = z.strictObject({
	width: z
		.number()
		.int()
		.min(BOX_LIMITS.viewport.minPx)
		.max(BOX_LIMITS.viewport.maxPx),
	height: z
		.number()
		.int()
		.min(BOX_LIMITS.viewport.minPx)
		.max(BOX_LIMITS.viewport.maxPx),
});

/**
 * Open a box. `mode` is any string so that `ios`, or a mode this Forge does not know, is refused
 * `BOX_MODE_UNAVAILABLE` by name rather than as a malformed body. `runId` is the agent's run, which
 * holds it; a person's open (`asPerson`) holds it as that person from the start ("Open a box to test
 * by hand"). `deviceId` pins a device; absent, the run's device, else the project's device with the
 * most headroom that serves the mode.
 */
export const openBoxRequestSchema = z.strictObject({
	mode: z.string().trim().min(1).max(40),
	issueId: z.uuid().optional(),
	criterion: z.number().int().min(1).optional(),
	runId: z.string().trim().min(1).max(120).optional(),
	deviceId: z.uuid().optional(),
	viewport: viewportSchema.optional(),
	url: z.string().trim().min(1).max(BOX_LIMITS.url).optional(),
	asPerson: z.boolean().optional(),
});
export type OpenBoxRequest = z.infer<typeof openBoxRequestSchema>;

export const boxActRequestSchema = z.strictObject({
	command: z
		.array(z.string().max(BOX_LIMITS.actArgChars))
		.min(1)
		.max(BOX_LIMITS.actArgs),
	runId: z.string().trim().min(1).max(120).optional(),
});

/** Mark where a criterion's demonstration starts or ends on the box's recording. */
export const boxSpanRequestSchema = z.strictObject({
	criterion: z.number().int().min(1),
	edge: z.enum(["start", "end"]),
});

export const boxTicketRequestSchema = z.strictObject({
	channel: z.enum(["view", "input"]),
});

export const boxCloseRequestSchema = z.strictObject({
	reason: z.string().trim().max(BOX_LIMITS.reason).optional(),
});

export const BOX_REFUSAL_CODES = [
	"BOX_NOT_FOUND",
	"BOX_FORBIDDEN",
	/** A person holds the box: the agent's state-changing act is refused, naming who and since when. */
	"BOX_HELD_BY_PERSON",
	/** The mode is unknown, unserved (`ios`), or the device lacks it: names what it lacks and the fix. */
	"BOX_MODE_UNAVAILABLE",
	/** The device's health has no room yet: names the queue position and the health reason. */
	"BOX_SLOT_UNAVAILABLE",
	/** The box is not running yet (waiting or opening): act on it once it is. */
	"BOX_NOT_READY",
	"BOX_CLOSED",
	/** Take, release or an input ticket from someone who does not hold the box as that act needs. */
	"BOX_NOT_HELD",
	"BOX_TICKET_INVALID",
	/** A span's end with no open start for that criterion, or a span on a box no issue holds. */
	"BOX_SPAN_INVALID",
	/** No device the project may use reports box health or a box-capable runner. */
	"BOX_NO_DEVICE",
] as const;
export type BoxRefusalCode = (typeof BOX_REFUSAL_CODES)[number];

/** The rest answer 422. */
export const BOX_REFUSAL_STATUSES = {
	BOX_NOT_FOUND: 404,
	BOX_FORBIDDEN: 403,
	BOX_HELD_BY_PERSON: 409,
	BOX_MODE_UNAVAILABLE: 409,
	BOX_SLOT_UNAVAILABLE: 409,
	BOX_NOT_READY: 409,
	BOX_CLOSED: 409,
	BOX_NOT_HELD: 409,
	BOX_TICKET_INVALID: 403,
	BOX_SPAN_INVALID: 409,
	BOX_NO_DEVICE: 409,
} as const satisfies RefusalStatuses<BoxRefusalCode>;

/** The REST and WebSocket doors. `:id` is a box, `:projectId` a project. */
export const BOX_ROUTES = {
	/** GET: the project's boxes and its waiting queue. POST: open one (`openBoxRequestSchema`). */
	ofProject: "/api/projects/:projectId/boxes",
	get: "/api/boxes/:id",
	close: "/api/boxes/:id/close",
	/** A person takes control; the agent's writes are refused from now. */
	take: "/api/boxes/:id/take",
	/** The holder hands back; the agent reads what the person did from `acts`. */
	release: "/api/boxes/:id/release",
	/** POST: an agent's act (`forge-runner box act`, MCP `forge_box`). GET: the feed, `?after=<seq>`. */
	acts: "/api/boxes/:id/acts",
	/** POST: mark a criterion's span start or end. GET: the box's spans and their clips. */
	spans: "/api/boxes/:id/spans",
	/** POST: a one-minute ticket for the view or input socket. */
	ticket: "/api/boxes/:id/ticket",
	/** Runner only: what the box did (`./box-wire.ts` `boxReportSchema`). */
	report: "/api/boxes/:id/report",
	/** Runner only, multipart `clip` + `still`: the span's cut, which core attaches to the criterion. */
	clip: "/api/boxes/:id/spans/:spanId/clip",
	/** A viewer's socket, `?ticket=<t>&fps=<n>`: watch-only, many at once. */
	view: "/ws/boxes/view",
	/** The holder's input socket, `?ticket=<t>`: one person's `BoxInput` lines to the box. */
	input: "/ws/boxes/input",
} as const;

/** Pushed to the project room when a box moves or is acted on; the Boxes page refetches. */
export interface BoxChangedFrame {
	boxId: string;
	projectId: string | null;
	issueId: string | null;
	state: BoxState;
	holder: string | null;
	/** The newest act's seq, so a feed reads only what it lacks. */
	actSeq: number | null;
	at: string;
}
