// A feedback item reproduced in a preview of the build its reporter used (REQ-41 BC-17..22;
// docs/proposals/chat-first.md, "Reproduce"). The preview relay injects a recorder into every page
// it serves for a `reproduce` preview; the recorder is rrweb 2.x (MIT) with its console and network
// plugins, set up by `RECORDER_OPTIONS`. Core keeps the scrubbed events for `RECORDING_LIMITS
// .retentionDays` and a short timeline for as long as the feedback item keeps its reporter data,
// and the assistant reads the timeline, never the raw events, to propose a cause and a fix (BC-19).
// The reporter's confirm on the fix preview answers the item's loop close ahead of time (BC-20).

import { z } from "zod";
import { PREVIEW_RESERVED_PATH, previewBuildSchema } from "./preview.js";
import type { RefusalStatuses } from "./refusal.js";
import { defineMachine } from "./state-machine.js";

/**
 * `recording`: the recorder is sending. `stopped`: ended by the viewer, the preview closing or the
 * length cap. `failed`: no batch ever arrived, or one broke the limits, with a reason. `expired`: past
 * retention, its events deleted and its timeline kept. `redacted`: the item's reporter data was
 * deleted (`feedback.redact`), events and timeline with it.
 */
export const RECORDING_STATES = [
	"recording",
	"stopped",
	"failed",
	"expired",
	"redacted",
] as const;
export type RecordingState = (typeof RECORDING_STATES)[number];

export const RECORDING_FAILURE_REASONS = [
	/** No batch arrived within `firstBatchSeconds` of the first page served: the app's own CSP or a non-HTML app kept the recorder out. */
	"RECORDER_BLOCKED",
	/** The recording passed `totalBytes`; what arrived before is kept. */
	"RECORDING_TOO_LARGE",
] as const;
export type RecordingFailureReason = (typeof RECORDING_FAILURE_REASONS)[number];

/** The recording's moves: the kernel's alone, except a viewer stopping their own recording. Registered with its table by the reproduce lane. */
export const RECORDING_MACHINE = defineMachine({
	entity: "recording",
	shapes: ["13b58405"],
	design: null,
	states: RECORDING_STATES,
	initial: ["recording"],
	terminal: ["failed", "redacted"],
	reasonRequired: ["failed", "redacted"],
	edges: [
		{
			from: "recording",
			to: "stopped",
			act: "recording.stopped",
			permission: "project.read",
			guards: [],
		},
		{
			from: "recording",
			to: "failed",
			act: "recording.failed",
			permission: null,
			guards: [],
		},
		{
			from: "stopped",
			to: "expired",
			act: "recording.expired",
			permission: null,
			guards: [],
		},
		{
			from: "recording",
			to: "redacted",
			act: "recording.redacted",
			permission: "feedback.redact",
			guards: [],
		},
		{
			from: "stopped",
			to: "redacted",
			act: "recording.redacted",
			permission: "feedback.redact",
			guards: [],
		},
		{
			from: "expired",
			to: "redacted",
			act: "recording.redacted",
			permission: "feedback.redact",
			guards: [],
		},
	],
});

export const RECORDING_LIMITS = {
	/** A recording stops itself after this long. */
	maxMinutes: 30,
	/** The recorder flushes a batch at least this often, as Sentry Replay does. */
	flushSeconds: 5,
	/** One batch, as posted (compressed or not). */
	batchBytes: 1024 * 1024,
	/** Events in one batch. */
	batchEvents: 5000,
	/** A whole recording, as stored. */
	totalBytes: 50 * 1024 * 1024,
	/** How long after the first page is served the first batch must arrive, or the recording is RECORDER_BLOCKED. */
	firstBatchSeconds: 30,
	/** Raw events are deleted this long after the recording stops; the timeline stays. */
	retentionDays: 30,
	/** Timeline entries kept per recording, newest dropped first past it. */
	timelineEntries: 500,
	/** One timeline entry's text. */
	entryText: 500,
} as const;

/**
 * How the injected recorder is set up: every input masked whatever its type, text an app marks
 * private masked, network requests recorded without headers or bodies, and console errors and
 * warnings with uncaught errors. The relay serves the recorder with these options and nothing reads
 * them from the page, so an app cannot turn masking off.
 */
export const RECORDER_OPTIONS = {
	record: {
		maskAllInputs: true,
		maskInputOptions: { password: true },
		maskTextSelector: "[data-forge-mask], [data-private]",
		blockSelector: "[data-forge-block]",
		recordCanvas: false,
		collectFonts: false,
		checkoutEveryNms: 5 * 60 * 1000,
	},
	console: { level: ["error", "warn", "assert"], lengthThreshold: 1000 },
	network: {
		initiatorTypes: ["fetch", "xmlhttprequest", "navigation"],
		recordHeaders: false,
		recordBody: false,
	},
} as const;

/** The recorder's two paths on a preview host, under the reserved prefix the dev server never sees. */
export const RECORDER_PATHS = {
	script: `${PREVIEW_RESERVED_PATH}rec.js`,
	ingest: `${PREVIEW_RESERVED_PATH}rec`,
} as const;

/** The custom events the injected recorder adds beside rrweb's own, so the timeline can name what was done. */
export const RECORDER_EVENTS = {
	/** A click, with the label of what was clicked: its aria-label or its first 80 characters of text; never an input's value. */
	click: "forge.click",
	/** A client-side route change (`history.pushState`, `popstate`), which rrweb's Meta does not record. */
	route: "forge.route",
} as const;

/** One rrweb event as posted: its type and time are read, its data kept as it came after scrubbing. */
const rrwebEventSchema = z.looseObject({
	type: z.int().min(0).max(6),
	timestamp: z.number().nonnegative(),
	data: z.unknown(),
});

/** `POST /__forge_preview/rec` on the preview host, behind the viewer cookie: one batch, in order. */
export const recordingBatchSchema = z.strictObject({
	recordingId: z.uuid(),
	/** 0, 1, 2…; a gap or a repeat is refused RECORDING_SEQ_GAP and the recorder resends from the next it owes. */
	seq: z.int().min(0),
	events: z.array(rrwebEventSchema).min(1).max(RECORDING_LIMITS.batchEvents),
});
export type RecordingBatch = z.infer<typeof recordingBatchSchema>;
export type RrwebEvent = z.infer<typeof rrwebEventSchema>;

export const TIMELINE_KINDS = [
	"navigate",
	"viewport",
	"click",
	"input",
	"console_error",
	"console_warn",
	"request_failed",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** One line of what happened, as the assistant and the feedback page read a recording. */
export const timelineEntrySchema = z.strictObject({
	/** Milliseconds since the recording's first event. */
	at: z.int().min(0),
	kind: z.enum(TIMELINE_KINDS),
	text: z.string().max(RECORDING_LIMITS.entryText),
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

// rrweb's enums (rrweb-io/rrweb packages/types/src/index.ts): EventType, IncrementalSource, MouseInteractions
const META = 4;
const INCREMENTAL = 3;
const CUSTOM = 5;
const PLUGIN = 6;
const SOURCE_MOUSE = 2;
const SOURCE_VIEWPORT = 4;
const SOURCE_INPUT = 5;
const MOUSE_CLICK = 2;

const clip = (s: string) =>
	s.length > RECORDING_LIMITS.entryText
		? `${s.slice(0, RECORDING_LIMITS.entryText - 1)}…`
		: s;
const obj = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
const str = (v: unknown): string | null =>
	typeof v === "string" && v.trim() !== "" ? v.trim() : null;

function entriesOf(e: RrwebEvent): Array<Omit<TimelineEntry, "at">> {
	const d = obj(e.data);
	if (e.type === META) {
		const out: Array<Omit<TimelineEntry, "at">> = [];
		const href = str(d.href);
		if (href) out.push({ kind: "navigate", text: `Opened ${href}` });
		if (typeof d.width === "number" && typeof d.height === "number")
			out.push({ kind: "viewport", text: `Window ${d.width}×${d.height}` });
		return out;
	}
	if (e.type === INCREMENTAL) {
		if (
			d.source === SOURCE_VIEWPORT &&
			typeof d.width === "number" &&
			typeof d.height === "number"
		)
			return [
				{ kind: "viewport", text: `Window resized to ${d.width}×${d.height}` },
			];
		// a click is read from the recorder's own labelled event; rrweb's bare one names only a node id
		if (d.source === SOURCE_MOUSE && d.type === MOUSE_CLICK) return [];
		if (d.source === SOURCE_INPUT)
			return [{ kind: "input", text: "Typed in a field (masked)" }];
		return [];
	}
	if (e.type === CUSTOM) {
		const payload = obj(d.payload);
		if (d.tag === RECORDER_EVENTS.click)
			return [
				{
					kind: "click",
					text: `Clicked ${str(payload.label) ?? "an unlabelled element"}`,
				},
			];
		if (d.tag === RECORDER_EVENTS.route && str(payload.href))
			return [{ kind: "navigate", text: `Went to ${str(payload.href)}` }];
		return [];
	}
	if (e.type === PLUGIN) {
		const payload = obj(d.payload);
		if (d.plugin === "rrweb/console@1") {
			const level = payload.level;
			const words = Array.isArray(payload.payload)
				? payload.payload.map(String).join(" ")
				: "";
			if (level === "error" || level === "assert")
				return [{ kind: "console_error", text: `console.${level}: ${words}` }];
			if (level === "warn")
				return [{ kind: "console_warn", text: `console.warn: ${words}` }];
			return [];
		}
		if (d.plugin === "rrweb/network@1" && Array.isArray(payload.requests)) {
			return payload.requests.flatMap((r) => {
				const q = obj(r);
				const status = typeof q.status === "number" ? q.status : null;
				if (status !== null && status > 0 && status < 400) return [];
				const method = str(q.method) ?? "GET";
				const url = str(q.name) ?? str(q.url) ?? "an unnamed request";
				return [
					{
						kind: "request_failed" as const,
						text: `${method} ${url} ${status ? `answered ${status}` : "failed with no answer"}`,
					},
				];
			});
		}
	}
	return [];
}

/**
 * A recording read as what the person did and what the page logged, in order: pages opened, window
 * sizes, labelled clicks, typing (never what was typed), console errors and warnings, and requests
 * that failed. The first `timelineEntries` are kept. Events must already be scrubbed: this reads
 * what it is given and adds no text of its own beyond the verbs.
 */
export function timelineOf(events: readonly RrwebEvent[]): TimelineEntry[] {
	if (events.length === 0) return [];
	const start = Math.min(...events.map((e) => e.timestamp));
	const out: TimelineEntry[] = [];
	for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
		for (const entry of entriesOf(e)) {
			out.push({
				at: Math.round(e.timestamp - start),
				kind: entry.kind,
				text: clip(entry.text),
			});
			if (out.length === RECORDING_LIMITS.timelineEntries) return out;
		}
	}
	return out;
}

/** One recording as REST answers it and the feedback page and the assistant read it. */
export const recordingRecordSchema = z.strictObject({
	id: z.uuid(),
	projectId: z.uuid(),
	feedbackId: z.uuid(),
	previewId: z.uuid(),
	build: previewBuildSchema,
	state: z.enum(RECORDING_STATES),
	reason: z.enum(RECORDING_FAILURE_REASONS).nullable(),
	/** The signed-in member whose session it is (BC-21). */
	recordedBy: z.uuid(),
	startedAt: z.iso.datetime(),
	stoppedAt: z.iso.datetime().nullable(),
	/** When the raw events are deleted; null until stopped. */
	expiresAt: z.iso.datetime().nullable(),
	events: z.int().min(0),
	bytes: z.int().min(0).max(RECORDING_LIMITS.totalBytes),
	timeline: z.array(timelineEntrySchema).max(RECORDING_LIMITS.timelineEntries),
});
export type RecordingRecord = z.infer<typeof recordingRecordSchema>;

export const RECORDING_REFUSAL_CODES = [
	"RECORDING_NOT_FOUND",
	/** A batch for a recording that is no longer `recording`. */
	"RECORDING_CLOSED",
	"RECORDING_SEQ_GAP",
	"RECORDING_BATCH_TOO_LARGE",
	"RECORDING_TOO_LARGE",
	/** Its events are past retention; the timeline is still read. */
	"RECORDING_EXPIRED",
	"RECORDING_REDACTED",
	/** Recordings open only for signed-in project members (BC-21). */
	"RECORDING_FORBIDDEN",
] as const;
export type RecordingRefusalCode = (typeof RECORDING_REFUSAL_CODES)[number];

export const RECORDING_REFUSAL_STATUSES = {
	RECORDING_NOT_FOUND: 404,
	RECORDING_CLOSED: 409,
	RECORDING_SEQ_GAP: 409,
	RECORDING_BATCH_TOO_LARGE: 400,
	RECORDING_EXPIRED: 409,
	RECORDING_REDACTED: 409,
	RECORDING_FORBIDDEN: 403,
} as const satisfies RefusalStatuses<RecordingRefusalCode>;

export const RECORDING_ROUTES = {
	/** GET: a feedback item's recordings, newest first. */
	ofFeedback: "/api/projects/:id/feedback/:fb/recordings",
	/** GET: one recording with its timeline. */
	get: "/api/recordings/:id",
	/** GET: its events, for replay in the feedback page, while within retention. */
	events: "/api/recordings/:id/events",
	stop: "/api/recordings/:id/stop",
} as const;

/** A reporter's word on a fix preview (BC-20), bound to the change they saw. */
export const fixConfirmationSchema = z.strictObject({
	feedbackId: z.uuid(),
	previewId: z.uuid(),
	/** `git patch-id --stable` of what the fix preview served when they confirmed. */
	patchId: z.string().regex(/^[0-9a-f]{40}$/),
	verdict: z.enum(["fixed", "not_fixed"]),
	note: z.string().max(2000).nullable(),
	by: z.uuid(),
	at: z.iso.datetime(),
});
export type FixConfirmation = z.infer<typeof fixConfirmationSchema>;

/**
 * The feedback item's loop close (`feedback-lifecycle` loop-check), answered from a confirm made
 * before the fix shipped: `gone` where the reporter said fixed and the change that shipped is the
 * one they saw (same patch id, the fast lane's own test), `not_gone` where they said not fixed,
 * and null where nothing they saw is what shipped, so the item asks again when it reads resolved.
 * The latest confirm wins.
 */
export function loopCloseFromConfirm(
	confirms: readonly Pick<FixConfirmation, "patchId" | "verdict" | "at">[],
	shippedPatchId: string | null,
): "gone" | "not_gone" | null {
	const latest = [...confirms].sort((a, b) => b.at.localeCompare(a.at))[0];
	if (!latest) return null;
	if (latest.verdict === "not_fixed") return "not_gone";
	return shippedPatchId !== null && latest.patchId === shippedPatchId
		? "gone"
		: null;
}
