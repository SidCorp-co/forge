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
 * start it, or to hand a warm one out, and has not said it answers yet. `warm`: running and nobody's yet, kept so the next request of its mode starts at once.
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

/** The states a box's processes run in: a device that stops listing such a box lost it (`BOX_GONE`). */
export const BOX_RUNNING_STATES = [
	"warm",
	"agent",
	"person",
] as const satisfies readonly BoxState[];

/**
 * The box's moves. `box.take` and `box.released` are a person's; `box.expired` is the kernel's, when a
 * person's hold went idle for `BOX_LIMITS.holdIdleSeconds`, taken as the recovery move; `box.idle` is
 * the kernel's close of an agent's box nothing used for `BOX_LIMITS.agentIdleSeconds`. `box.started` (waiting → opening) is
 * core's allocation, never a caller's. Every move is recorded with who made it and when, in
 * `kernel_transitions` (`entity: "box"`).
 */
export const BOX_MACHINE = defineMachine({
	entity: "box",
	shapes: ["3ee3cdb7", "8238685f", "06721e94"],
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
		{
			from: "opening",
			to: "warm",
			act: "box.warm",
			permission: null,
			guards: [],
		},
		{
			from: "opening",
			to: "agent",
			act: "box.ready",
			permission: null,
			guards: [],
		},
		{
			from: "opening",
			to: "person",
			act: "box.ready",
			permission: null,
			guards: [],
		},
		// a warm box given to a request opens again until the device says its screen still answers
		// (ISS-1324): a warm box is never read as running for anyone before that `ready`
		{
			from: "warm",
			to: "opening",
			act: "box.assigned",
			permission: null,
			guards: [],
		},
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
		// the kernel's hand-back when a hold went idle: taken as the recovery move, so a person's release
		// and the sweep's expiry are two records of one edge pair
		{
			from: "person",
			to: "agent",
			act: "box.expired",
			permission: null,
			guards: [],
			recovery: true,
		},
		// the kernel's close of an agent's box nothing used for `BOX_LIMITS.agentIdleSeconds` (ISS-1335):
		// its opener may be gone or refused every later call, and the box held the device's headroom
		{
			from: "agent",
			to: "closed",
			act: "box.idle",
			permission: null,
			guards: [],
			recovery: true,
		},
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
	/**
	 * The box's own screen stopped answering (an emulator `adb` no longer reaches, a browser daemon
	 * or desktop display gone), found at its hand-out or by the device's sweep (ISS-1324). `detail`
	 * holds the check's answer and the log tail.
	 */
	"BOX_DEVICE_GONE",
] as const;
export type BoxFailure = (typeof BOX_FAILURES)[number];

export const BOX_LIMITS = {
	/** A person's hold with no input this long expires back to the agent, on the record. */
	holdIdleSeconds: 300,
	/**
	 * An agent's box with no act, span, recording change or hold this long is closed `idle` by the
	 * sweep (ISS-1335): a builder keeps one open while it builds, so it is long.
	 */
	agentIdleSeconds: 3600,
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

/**
 * Why a box records (ISS-1321; owner 2026-11-18: recording costs resources, so it is optional).
 * Nothing records by default and a warm box never does. `asked`: the open named `record: true`, or
 * an agent turned it on. `span`: a criterion's span began it, and the last open span's end stops it.
 * `person`: a person turned it on from the Boxes page. Only a `span` recording ends with a span.
 */
/**
 * Why a box closed: `done`, closed by a caller (its agent, a person); `idle`, closed by the sweep once
 * nothing used it for `BOX_LIMITS.agentIdleSeconds` (ISS-1335). Null on a box not closed.
 */
export const BOX_CLOSED_WHY = ["done", "idle"] as const;
export type BoxClosedWhy = (typeof BOX_CLOSED_WHY)[number];

export const BOX_RECORDING_WHY = ["asked", "span", "person"] as const;
export type BoxRecordingWhy = (typeof BOX_RECORDING_WHY)[number];

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
	/**
	 * Its recording (ISS-1321): null while nothing was ever recorded. `state` is `recording` while
	 * the device records, `kept` once it stopped with what it recorded still on the device, `dropped`
	 * once its issue ended. `why` says who wants it recording now (null when it does not record);
	 * `startedAt` is when the device began the recording now running, or the last one.
	 */
	recording: {
		state: "recording" | "kept" | "dropped";
		why: BoxRecordingWhy | null;
		startedAt: string | null;
	} | null;
	failure: BoxFailure | null;
	detail: string | null;
	openedBy: string;
	createdAt: string;
	closedAt: string | null;
	/** Why it closed, once `closed`: by a caller, or by the sweep when idle. */
	closedWhy: BoxClosedWhy | null;
}

/**
 * How an act reached the box: `act`, an agent's command through the act door (`forge-runner box
 * act`, forge_box `act`); `input`, a person's input socket; `cdp`, a session an agent attached to a
 * browser box's CDP (`attach`, ISS-1322), whose writes the device reports by method name.
 */
export const BOX_ACT_VIA = ["act", "input", "cdp"] as const;
export type BoxActVia = (typeof BOX_ACT_VIA)[number];

/** One act on a box: the agent's command, or the person's input, in the order the box got them. */
export interface BoxActRecord {
	id: string;
	boxId: string;
	seq: number;
	by: "agent" | "person";
	/** The run or the person, as `holderKey` writes it. */
	actor: string;
	kind: "read" | "write" | "input";
	via: BoxActVia;
	/**
	 * The driver argv for an agent's act; for a person's input, its `BoxInput` as JSON; for an
	 * attached session (`via: cdp`), the CDP method and, where it ran several times in a row, `×n`
	 * (`attach` itself reads `["attach"]`).
	 */
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

export function actKindOf(
	mode: BoxMode,
	command: readonly string[],
): "read" | "write" {
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
 * Open a box. `record` asks for the session's recording from the start; without it nothing records
 * until a span or a person starts it. `mode` is any string so that `ios`, or a mode this Forge does not know, is refused
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
	/** Record the session from the start (ISS-1321). Absent or false: nothing records until asked. */
	record: z.boolean().optional(),
});
export type OpenBoxRequest = z.infer<typeof openBoxRequestSchema>;

export const boxActRequestSchema = z.strictObject({
	command: z
		.array(z.string().max(BOX_LIMITS.actArgChars))
		.min(1)
		.max(BOX_LIMITS.actArgs),
	runId: z.string().trim().min(1).max(120).optional(),
});

/** Attach to a box's native endpoint (ISS-1322): `runId` is the run the feed's `attach` line names. */
export const boxAttachRequestSchema = z.strictObject({
	runId: z.string().trim().min(1).max(120).optional(),
});

/** Mark where a criterion's demonstration starts or ends on the box's recording. */
export const boxSpanRequestSchema = z.strictObject({
	criterion: z.number().int().min(1),
	edge: z.enum(["start", "end"]),
});

/** Start (`on: true`) or stop a box's recording: its holder or a project writer (ISS-1321). */
export const boxRecordingRequestSchema = z.strictObject({ on: z.boolean() });

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
	/**
	 * An attach from a caller not on the box's device (another device, or a credential bound to
	 * none): the endpoint is the device's loopback and no tunnel carries it yet. The act door works
	 * from anywhere.
	 */
	"BOX_ATTACH_REMOTE",
	/**
	 * The box hands out no native endpoint: its mode's (an adb serial, an X display) cannot be taken
	 * back when a person takes the box, or its device reported none (a runner older than ISS-1322).
	 */
	"BOX_ATTACH_UNAVAILABLE",
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
	BOX_ATTACH_REMOTE: 409,
	BOX_ATTACH_UNAVAILABLE: 409,
} as const satisfies RefusalStatuses<BoxRefusalCode>;

/** The REST and WebSocket doors. `:id` is a box (a project under `/api/projects`). */
export const BOX_ROUTES = {
	/** GET: the project's boxes and its waiting queue. POST: open one (`openBoxRequestSchema`). */
	ofProject: "/api/projects/:id/boxes",
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
	/**
	 * POST: the mode's native endpoint for an agent on the box's own device (ISS-1322): a browser
	 * box's CDP URL, served by the device's proxy where the person's hold binds. `BoxAttachAnswer`.
	 */
	attach: "/api/boxes/:id/attach",
	/** POST `{ on }`: start or stop the box's recording (ISS-1321). */
	recording: "/api/boxes/:id/recording",
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

/**
 * The modes whose native endpoint an agent may attach to: those whose device takes back what an
 * attached tool sends when a person takes the box. A browser's CDP goes through the device's proxy;
 * an adb serial or an X display has no such door yet, so those modes attach nothing.
 */
export const BOX_ATTACH_MODES = ["browser"] as const satisfies readonly BoxMode[];

/** What `attach` answers: the box, and the URL `connectOverCDP` or `--browserUrl` takes. */
export interface BoxAttachAnswer {
	box: BoxRecord;
	attach: { mode: "browser"; cdp: string };
}

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
