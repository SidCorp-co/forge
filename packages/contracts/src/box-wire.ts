// What crosses between core and a device's runner for a Forge Box (ISS-1276; ADR 0015), and between
// core and a viewer's page. The runner reports facts (headroom, the modes it can serve and what each
// costs, what it holds, what an act printed) and runs what it is told; core takes every decision.
// The runner's `runner-box` crate mirrors this file. `./boxes.ts` is the record and its doors.
//
// Four paths, each with one job:
// - the heartbeat's `box` field: the device's health and modes (`boxHealthReportSchema`);
// - `device.pushed` frames core → runner (`BoxControlFrames`), on the control socket the runner
//   already holds, written in the transaction of the move that owes them;
// - `POST /api/boxes/:id/report` runner → core (`boxReportSchema`), and the span clip upload;
// - the preview tunnel (`./preview-tunnel.ts`, `/ws/preview-tunnel`): one stream per viewer or input
//   socket, opened by core with `{ boxId, channel, fps }` and copied byte for byte by the runner to
//   the box's loopback endpoint for that channel. No new port and no tailnet.

import { z } from "zod";
import {
	BOX_DEVICE_SESSION_FAULTS,
	BOX_LIMITS,
	BOX_MODES,
	BOX_UNSERVED_MODES,
	type BoxMode,
} from "./boxes.js";

// ---------- health: the heartbeat's `box` field ----------

const mb = z.number().int().nonnegative();

/** What one mode costs while a box of it runs, as the runner measured it. Android costs more. */
export const boxCostSchema = z.strictObject({
	memoryMb: mb,
	diskMb: mb,
	/** Cores it takes while driven (an emulator swiping took 3–4 on sid-xeon-1). */
	cpuCores: z.number().nonnegative().max(512),
});
export type BoxCost = z.infer<typeof boxCostSchema>;

/**
 * One mode as the device can serve it. `serves: false` names what is missing (`lacks`, e.g.
 * `["adb", "kvm group"]`) and the command that fixes it (`fix`, e.g. `forge-runner setup`); core
 * refuses a request for it `BOX_MODE_UNAVAILABLE` with both. `ios` is reported unserved by name.
 */
export const boxModeReportSchema = z.strictObject({
	mode: z.enum([...BOX_MODES, ...BOX_UNSERVED_MODES]),
	serves: z.boolean(),
	lacks: z.array(z.string().max(200)).max(20),
	fix: z.string().max(500).nullable(),
	cost: boxCostSchema,
	/** The pinned tool versions it runs (`[box]` in the runner's config.toml). */
	versions: z.record(z.string().max(60), z.string().max(60)),
});
export type BoxModeReport = z.infer<typeof boxModeReportSchema>;

/**
 * The device's headroom for boxes, measured each heartbeat. The reserves and the pressure ceiling are
 * the device's own resource limits from its runner config (`[box]`), like `max_job_panes`; core
 * reads them, compares and decides. There is no count of boxes anywhere: capacity is what the
 * measurement leaves.
 */
export const boxHealthReportSchema = z.strictObject({
	memory: z.strictObject({ availableMb: mb, reserveMb: mb }),
	/** `/proc/pressure/cpu` `some avg10`, percent; above `ceiling`, nothing new starts. */
	cpu: z.strictObject({
		pressureSomeAvg10: z.number().min(0).max(100),
		ceiling: z.number().min(0).max(100),
	}),
	disk: z.strictObject({ freeMb: mb, reserveMb: mb }),
	/** Whether `/dev/kvm` is writable by the runner's user. */
	kvm: z.boolean(),
	modes: z.array(boxModeReportSchema).max(8),
	/** Every box id the runner holds processes for now; one core thinks running and absent here fails `BOX_GONE`. */
	held: z.array(z.uuid()).max(512),
});
export type BoxHealthReport = z.infer<typeof boxHealthReportSchema>;

// ---------- core → runner: `device.pushed` frames ----------

/** How a box's screen reaches a viewer, per mode. */
export const BOX_VIEW_CODECS = {
	/** agent-browser's stream WebSocket: `{type:"frame",seq,data:<base64 JPEG>,metadata}` messages. */
	browser: "jpeg-frames",
	/** scrcpy server's video socket, H.264 with codec and frame meta; the page decodes with WebCodecs. */
	android: "scrcpy-h264",
	/** x11vnc RFB (`-viewonly -shared` for view); the page runs noVNC. */
	desktop: "rfb",
} as const satisfies Record<BoxMode, string>;
export type BoxViewCodec = (typeof BOX_VIEW_CODECS)[BoxMode];

export interface BoxControlFrames {
	/**
	 * Start a box. `warm`: start it with nobody's work, kept for the next request of its mode; a
	 * warm box never records. `record`: start the session's recording once it is up (agent-browser
	 * `record`, ffmpeg x11grab, the emulator's recording); without it nothing records (ISS-1321).
	 * The runner answers `ready` with its view offer, and `recordingStartedAt` where it records, or
	 * `failed`.
	 */
	"box.open": {
		boxId: string;
		mode: BoxMode;
		warm: boolean;
		record: boolean;
		viewport: { width: number; height: number } | null;
		url: string | null;
		openTimeoutSeconds: number;
		/** Opened for a person to test by hand: they hold it from the open, input admitted at once. */
		asPerson: boolean;
	};
	/** Stop it and reap every process it started. The recording stays until `box.recording.drop`. */
	"box.close": { boxId: string; why: "done" | "failed" | "superseded" | "idle" };
	/** Run one driver command (`kind` as core classed it) and answer an `act` report with `actId`. */
	"box.act": {
		boxId: string;
		actId: string;
		command: string[];
		kind: "read" | "write";
	};
	/**
	 * A warm box was given to work: the runner first checks its screen still answers, failing it
	 * `BOX_DEVICE_GONE` where it does not (ISS-1324), then navigates to `url` where one is named. Its
	 * evidence starts here, so a warm box's idle minutes are never evidence, and it answers
	 * `ready`, with `recordingStartedAt` where `record` started its recording here. `asPerson`: a
	 * person holds it from the hand-out.
	 */
	"box.assign": {
		boxId: string;
		url: string | null;
		asPerson: boolean;
		record: boolean;
	};
	/**
	 * Start (`on: true`) or stop the box's recording, answered by a `recording` report (ISS-1321).
	 * Stopping closes what was recorded into a segment a span's cut still reads.
	 */
	"box.recording.set": { boxId: string; on: boolean };
	/**
	 * A person holds it: the runner accepts `input` channel streams for it from now, and its CDP
	 * proxy refuses an attached session's writes `BOX_HELD_BY_PERSON` (ISS-1322).
	 */
	"box.take": { boxId: string; userId: string; name: string | null };
	/**
	 * Back to the agent (`released`, or `expired` by idle): the runner refuses input streams again,
	 * and attached sessions' writes pass again.
	 */
	"box.release": { boxId: string; why: "released" | "expired" };
	/**
	 * Note where a criterion's span starts or ends on the recording; answered by a `mark` report.
	 * `recording: "start"`: the box was not recording, so the runner starts its recording before
	 * the start's mark; `"stop"`: this end closes the recording a span began, after the end's mark
	 * (ISS-1321). Null leaves the recording as it is.
	 */
	"box.span.mark": {
		boxId: string;
		spanId: string;
		criterion: number;
		edge: "start" | "end";
		recording: "start" | "stop" | null;
	};
	/**
	 * Cut the span's clip and its opening still from the recording, between the offsets the `mark`
	 * reports gave, within the release page's ceiling, and upload them to `BOX_ROUTES.clip`.
	 */
	"box.recording.fetch": {
		boxId: string;
		spanId: string;
		fromMs: number;
		toMs: number;
		maxSeconds: number;
		maxBytes: number;
	};
	/** The issue ended (closed or dropped): delete the box's recording from the device. */
	"box.recording.drop": { boxId: string };
	/**
	 * Send the box's whole kept recording to Forge (ISS-1338): every segment in order, encoded to one
	 * clip within `maxBytes` (`BOX_LIMITS.sessionMaxBytes`) with its opening still, uploaded to
	 * `BOX_ROUTES.clip` with `session` in the span's place, as a span's cut is. Core sends it after
	 * `box.close`, only for a recording a person or the open asked for; one that cannot be sent
	 * answers a `session_failed` report.
	 */
	"box.recording.upload": { boxId: string; maxBytes: number };
}

// ---------- runner → core: `POST /api/boxes/:id/report` ----------

const offerSchema = z.strictObject({
	codec: z.enum(["jpeg-frames", "scrcpy-h264", "rfb"]),
	width: z.number().int().min(1).max(8192),
	height: z.number().int().min(1).max(8192),
});

/**
 * - `state`: the box is up (`ready`, with the view `offer` and when its recording started), it could
 *   not start or stopped (`failed`, a `BoxFailure` and the tool's words; `BOX_DEVICE_GONE` for a
 *   warm box whose screen no longer answers), or it is gone.
 * - `offer`: the view moved (agent-browser restarted on a new stream port, the emulator rotated).
 *   The port itself never leaves the device; the runner re-reads it and a lost one is `failed`
 *   `STREAM_LOST`, loudly.
 * - `act`: what a `box.act` did.
 * - `mark`: the recording offset a `box.span.mark` landed at.
 * - `clip_failed`: a `box.recording.fetch` could not be cut or exceeded the ceiling.
 * - `session_failed`: a `box.recording.upload` could not be sent, `fault` saying why (ISS-1338).
 * - `recording`: the recording started (`on`, at `at`) or stopped, or could not (`failed`, with the
 *   tool's words in `detail`), after `box.recording.set` or a span's `recording`.
 * - `cdp`: what sessions attached to a browser box's CDP did (ISS-1322): each method that is not a
 *   read, in order, a run of one method as one line with its `count`, `refused` where the person's
 *   hold refused it. Core writes each into the act feed `via: cdp`.
 *
 * A browser box's `ready` carries `attach.cdp`, the loopback URL of the device's CDP proxy, which
 * core hands only to an agent on that device (`BOX_ROUTES.attach`).
 */
export const boxReportSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("state"),
		state: z.enum(["ready", "failed", "gone"]),
		offer: offerSchema.optional(),
		recordingStartedAt: z.iso.datetime().optional(),
		attach: z
			.strictObject({
				cdp: z
					.string()
					.regex(
						/^http:\/\/127\.0\.0\.1:\d{1,5}$/,
						"the device's loopback proxy: http://127.0.0.1:<port>",
					),
			})
			.optional(),
		failure: z
			.enum([
				"START_FAILED",
				"STREAM_LOST",
				"BOX_GONE",
				"DEVICE_OFFLINE",
				"BOX_DEVICE_GONE",
			])
			.optional(),
		detail: z.string().max(4000).optional(),
	}),
	z.strictObject({ kind: z.literal("offer"), offer: offerSchema }),
	z.strictObject({
		kind: z.literal("act"),
		actId: z.uuid(),
		exitCode: z.number().int(),
		stdout: z.string().max(BOX_LIMITS.actStdoutBytes),
		stderr: z.string().max(BOX_LIMITS.actStderrBytes),
		durationMs: z.number().int().nonnegative(),
	}),
	z.strictObject({
		kind: z.literal("mark"),
		spanId: z.uuid(),
		edge: z.enum(["start", "end"]),
		offsetMs: z.number().int().nonnegative(),
	}),
	z.strictObject({
		kind: z.literal("clip_failed"),
		spanId: z.uuid(),
		detail: z.string().max(4000),
	}),
	z.strictObject({
		kind: z.literal("session_failed"),
		fault: z.enum(BOX_DEVICE_SESSION_FAULTS),
		detail: z.string().max(4000),
	}),
	z.strictObject({
		kind: z.literal("cdp"),
		acts: z
			.array(
				z.strictObject({
					method: z.string().min(1).max(120),
					count: z.number().int().min(1).max(1_000_000),
					refused: z.boolean(),
				}),
			)
			.min(1)
			.max(100),
	}),
	z.strictObject({
		kind: z.literal("recording"),
		state: z.enum(["on", "off", "failed"]),
		at: z.iso.datetime(),
		detail: z.string().max(4000).optional(),
	}),
]);
export type BoxReport = z.infer<typeof boxReportSchema>;

// ---------- the tunnel: one stream per viewer or input socket ----------

/**
 * A tunnel stream's channel (`./preview-tunnel.ts` open payload `{boxId, channel, fps}`):
 * - `view`: the mode's native screen bytes (`BOX_VIEW_CODECS`), watch-only at the source where the
 *   source allows it (scrcpy with `control=false`, x11vnc `-viewonly`) and filtered by core where it
 *   does not (agent-browser's socket takes input, so core forwards only its frames to a viewer).
 *   `fps` is the viewer's own rate: scrcpy `max_fps`; core throttles agent-browser frames per viewer.
 * - `input`: newline-delimited `BoxInput` JSON from the holder, which the runner translates for the
 *   mode (agent-browser `input_mouse`/`input_keyboard`, scrcpy control messages, X11 events). The
 *   runner refuses an input stream for a box it was not told is held (`box.take`).
 */
export const BOX_STREAM_CHANNELS = ["view", "input"] as const;
export type BoxStreamChannel = (typeof BOX_STREAM_CHANNELS)[number];

const unit = z.number().min(0).max(1);

/**
 * A person's input, in the box's own coordinates normalised to 0..1 of its view, so the page needs
 * no device pixels. Core validates each line, records it as the person's act, and forwards it.
 */
export const boxInputSchema = z.discriminatedUnion("t", [
	z.strictObject({ t: z.literal("tap"), x: unit, y: unit }),
	z.strictObject({
		t: z.literal("pointer"),
		action: z.enum(["down", "move", "up"]),
		x: unit,
		y: unit,
	}),
	z.strictObject({
		t: z.literal("scroll"),
		x: unit,
		y: unit,
		dx: z.number().min(-10_000).max(10_000),
		dy: z.number().min(-10_000).max(10_000),
	}),
	z.strictObject({
		t: z.literal("key"),
		key: z.string().min(1).max(40),
		action: z.enum(["down", "up", "press"]),
	}),
	z.strictObject({ t: z.literal("text"), text: z.string().min(1).max(1000) }),
]);
export type BoxInput = z.infer<typeof boxInputSchema>;

// ---------- the viewer's page: `/ws/boxes/view` and `/ws/boxes/input` ----------

/**
 * Text messages core sends a viewer, beside the codec's own messages (text `frame` JSON for
 * `jpeg-frames`, binary chunks for `scrcpy-h264` and `rfb`): a `hello` first, then a `holder`
 * whenever the hold moves, and `closed` before the socket ends.
 */
export type BoxViewerMessage =
	| {
			type: "hello";
			boxId: string;
			codec: BoxViewCodec;
			width: number;
			height: number;
			fps: number;
			holder: string | null;
			/** Always true on the view socket: input travels only on the holder's input socket. */
			watchOnly: true;
	  }
	| { type: "holder"; holder: string | null; since: string | null }
	/** A `jpeg-frames` picture: agent-browser's frame, re-said by core in this shape. */
	| { type: "frame"; seq: number | null; data: string }
	/** `code` names a view whose stream could not be read (ISS-1315); `why` says it in words. */
	| { type: "closed"; why: string; code?: BoxViewFault };

/**
 * Why a browser box's view ended though the box runs: agent-browser's stream could not be read
 * after opening it again (`STREAM_UNREADABLE`), or it sent no frame (`STREAM_SILENT`).
 */
export type BoxViewFault = "STREAM_UNREADABLE" | "STREAM_SILENT";

export const boxViewQuerySchema = z.strictObject({
	ticket: z.string().min(1).max(2000),
	fps: z.coerce
		.number()
		.int()
		.min(BOX_LIMITS.viewFpsMin)
		.max(BOX_LIMITS.viewFpsMax)
		.optional(),
});
