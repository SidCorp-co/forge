// The preview tunnel's frames (REQ-39 BC-5): how one
// WebSocket the runner opens to core carries many TCP connections to a preview's dev server, HTTP
// and the dev server's hot-reload WebSocket alike. Core opens a stream per browser connection; the
// runner connects it to the preview's loopback port and copies bytes both ways, parsing none of
// them. The header is yamux's (hashicorp/yamux spec.md: 12 bytes, big-endian, a per-stream window
// of 256 KiB granted back by window updates) with version 1 so the two are never mistaken for each
// other. One frame is one binary WebSocket message; core's half is TypeScript, the runner's is Rust
// and mirrors this file, held to it by the fixtures in `preview-tunnel.test.ts`.

export const TUNNEL_VERSION = 1;
export const TUNNEL_HEADER_BYTES = 12;

/**
 * `open`: core asks for a new stream to a preview; payload is UTF-8 JSON `{"previewId": uuid}`, or to
 * a Forge Box's channel (ISS-1276, `./box-wire.ts`): `{"boxId": uuid, "channel": "view", "fps": n}`
 * or `{"boxId": uuid, "channel": "input"}`, which the runner copies to that box's loopback endpoint.
 * `data`: bytes of the stream. `window`: the sender may send `length` more bytes on the stream.
 * `close`: the sender writes no more (half-close, a TCP FIN). `reset`: the stream is gone at
 * once; `length` holds a `TunnelResetCode`.
 */
export const TUNNEL_FRAME_TYPES = {
	open: 1,
	data: 2,
	window: 3,
	close: 4,
	reset: 5,
} as const;
export type TunnelFrameType = keyof typeof TUNNEL_FRAME_TYPES;

export const TUNNEL_RESET_CODES = {
	/** The dev server refused the loopback connection. */
	CONNECT_REFUSED: 1,
	/** The runner holds no running preview by that id. */
	PREVIEW_NOT_RUNNING: 2,
	/** Opening it would pass `maxStreamsPerPreview` or `maxStreamsPerTunnel`. */
	STREAM_LIMIT: 3,
	/** A frame broke this contract; the stream is dropped, the tunnel kept. */
	PROTOCOL: 4,
	/** The sender sent past the window it was granted. */
	WINDOW_EXCEEDED: 5,
	/** The browser went away, or the preview closed. */
	CANCELLED: 6,
	/** No byte moved either way for `streamIdleSeconds`. */
	IDLE: 7,
} as const;
export type TunnelResetCode = keyof typeof TUNNEL_RESET_CODES;

export const TUNNEL_LIMITS = {
	/** The most bytes one `data` frame carries, so a large asset never holds the socket from the rest. */
	maxDataBytes: 65_536,
	/** An `open` payload. */
	maxOpenBytes: 1024,
	/** Each side may send this much on a new stream before a `window` frame grants more (yamux's). */
	initialWindow: 262_144,
	/** A receiver grants back what it consumed once that reaches half the window. */
	windowUpdateAt: 131_072,
	maxStreamsPerPreview: 64,
	maxStreamsPerTunnel: 512,
	/**
	 * A request past those limits waits for a stream rather than being refused: this many may wait per
	 * preview (the hard cap; the next is refused at once as "queue full") ...
	 */
	maxQueuedPerPreview: 256,
	/** ... and one that waits this long is refused as "wait timed out". */
	streamWaitSeconds: 15,
	/**
	 * The box's own backstop, twice core's: core forgets a stream when it sends its reset and the
	 * box when it reads it, so the box counting against core's numbers would refuse a stream core
	 * had already released.
	 */
	boxStreamsPerPreview: 128,
	boxStreamsPerTunnel: 1024,
	/** Above this many bytes queued on the socket, core stops reading from browsers until it drains. */
	socketHighWater: 4 * 1024 * 1024,
	streamIdleSeconds: 300,
} as const;

export type TunnelFrame =
	| { type: "open"; streamId: number; previewId: string }
	| ({ type: "open"; streamId: number } & TunnelBoxTarget)
	| { type: "data"; streamId: number; bytes: Uint8Array }
	| { type: "window"; streamId: number; delta: number }
	| { type: "close"; streamId: number }
	| { type: "reset"; streamId: number; code: TunnelResetCode };

/**
 * A Forge Box stream's target (ISS-1276): `view` carries the box's screen at the viewer's `fps`,
 * `input` the holder's input lines. `./box-wire.ts` says what each carries per mode.
 */
export type TunnelBoxTarget =
	| { boxId: string; channel: "view"; fps: number }
	| { boxId: string; channel: "input" };

/** The most frames a second a box view stream is opened at, and the fewest. */
export const TUNNEL_BOX_FPS = { min: 1, max: 30 } as const;

/** Why bytes are not a frame; the receiver resets the stream it names, or drops the message. */
export type TunnelDecodeFault = {
	ok: false;
	/** The stream the bytes named, where the header could be read far enough to tell. */
	streamId: number | null;
	detail: string;
};

const TYPE_BY_CODE = new Map<number, TunnelFrameType>(
	Object.entries(TUNNEL_FRAME_TYPES).map(([name, code]) => [
		code,
		name as TunnelFrameType,
	]),
);
const RESET_BY_CODE = new Map<number, TunnelResetCode>(
	Object.entries(TUNNEL_RESET_CODES).map(([name, code]) => [
		code,
		name as TunnelResetCode,
	]),
);
const UINT32_MAX = 0xffff_ffff;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The frame as one binary WebSocket message. Refuses, by name, a frame this contract forbids. */
export function encodeTunnelFrame(frame: TunnelFrame): Uint8Array {
	if (
		!Number.isInteger(frame.streamId) ||
		frame.streamId < 1 ||
		frame.streamId > UINT32_MAX
	) {
		throw new RangeError(
			`tunnel frame streamId ${frame.streamId} is not 1..${UINT32_MAX}`,
		);
	}
	let payload: Uint8Array = new Uint8Array(0);
	let length = 0;
	switch (frame.type) {
		case "open":
			payload = new TextEncoder().encode(JSON.stringify(openBody(frame)));
			length = payload.byteLength;
			break;
		case "data":
			if (
				frame.bytes.byteLength === 0 ||
				frame.bytes.byteLength > TUNNEL_LIMITS.maxDataBytes
			) {
				throw new RangeError(
					`tunnel data frame carries ${frame.bytes.byteLength} bytes; one carries 1..${TUNNEL_LIMITS.maxDataBytes}`,
				);
			}
			payload = frame.bytes;
			length = payload.byteLength;
			break;
		case "window":
			if (
				!Number.isInteger(frame.delta) ||
				frame.delta < 1 ||
				frame.delta > UINT32_MAX
			) {
				throw new RangeError(
					`tunnel window delta ${frame.delta} is not 1..${UINT32_MAX}`,
				);
			}
			length = frame.delta;
			break;
		case "close":
			break;
		case "reset":
			length = TUNNEL_RESET_CODES[frame.code];
			break;
	}
	const out = new Uint8Array(TUNNEL_HEADER_BYTES + payload.byteLength);
	const view = new DataView(out.buffer);
	view.setUint8(0, TUNNEL_VERSION);
	view.setUint8(1, TUNNEL_FRAME_TYPES[frame.type]);
	view.setUint16(2, 0);
	view.setUint32(4, frame.streamId);
	view.setUint32(8, length);
	out.set(payload, TUNNEL_HEADER_BYTES);
	return out;
}

/** One binary WebSocket message read back into its frame, or the fault that stops it being one. */
export function decodeTunnelFrame(
	message: Uint8Array,
): { ok: true; frame: TunnelFrame } | TunnelDecodeFault {
	if (message.byteLength < TUNNEL_HEADER_BYTES) {
		return fault(
			null,
			`a tunnel frame is at least ${TUNNEL_HEADER_BYTES} bytes; this message is ${message.byteLength}`,
		);
	}
	const view = new DataView(
		message.buffer,
		message.byteOffset,
		message.byteLength,
	);
	const streamId = view.getUint32(4);
	const version = view.getUint8(0);
	if (version !== TUNNEL_VERSION) {
		return fault(
			null,
			`tunnel frame version ${version}; this side speaks ${TUNNEL_VERSION}`,
		);
	}
	const type = TYPE_BY_CODE.get(view.getUint8(1));
	if (type === undefined)
		return fault(
			streamId,
			`tunnel frame type ${view.getUint8(1)} is not one of 1..5`,
		);
	if (view.getUint16(2) !== 0)
		return fault(streamId, "tunnel frame flags are reserved and must be 0");
	if (streamId === 0) return fault(null, "tunnel stream 0 is reserved");
	const length = view.getUint32(8);
	const payload = message.subarray(TUNNEL_HEADER_BYTES);
	const carries = type === "open" || type === "data";
	if (carries && payload.byteLength !== length) {
		return fault(
			streamId,
			`tunnel ${type} frame says ${length} bytes and carries ${payload.byteLength}`,
		);
	}
	if (!carries && payload.byteLength !== 0) {
		return fault(
			streamId,
			`tunnel ${type} frame carries ${payload.byteLength} bytes; it carries none`,
		);
	}
	switch (type) {
		case "open": {
			if (length > TUNNEL_LIMITS.maxOpenBytes) {
				return fault(
					streamId,
					`tunnel open payload is ${length} bytes; at most ${TUNNEL_LIMITS.maxOpenBytes}`,
				);
			}
			const target = openTarget(payload);
			if (target === null) {
				return fault(
					streamId,
					'tunnel open payload is not {"previewId": "<uuid>"}, {"boxId": "<uuid>", "channel": "view", "fps": 1..30} or {"boxId": "<uuid>", "channel": "input"}',
				);
			}
			return { ok: true, frame: { type, streamId, ...target } };
		}
		case "data":
			if (length === 0 || length > TUNNEL_LIMITS.maxDataBytes) {
				return fault(
					streamId,
					`tunnel data frame carries ${length} bytes; one carries 1..${TUNNEL_LIMITS.maxDataBytes}`,
				);
			}
			return { ok: true, frame: { type, streamId, bytes: payload } };
		case "window":
			if (length === 0) return fault(streamId, "tunnel window delta is 0");
			return { ok: true, frame: { type, streamId, delta: length } };
		case "close":
			if (length !== 0)
				return fault(streamId, `tunnel close frame says ${length}; it says 0`);
			return { ok: true, frame: { type, streamId } };
		case "reset": {
			const code = RESET_BY_CODE.get(length);
			if (code === undefined)
				return fault(
					streamId,
					`tunnel reset code ${length} is not one of 1..7`,
				);
			return { ok: true, frame: { type, streamId, code } };
		}
	}
}

type OpenFrame = Extract<TunnelFrame, { type: "open" }>;

/** The open payload's object, refusing by name a target this contract does not allow. */
function openBody(frame: OpenFrame): Record<string, unknown> {
	if ("previewId" in frame) {
		if (!UUID.test(frame.previewId)) {
			throw new RangeError(
				`tunnel open names previewId "${frame.previewId}", which is not a uuid`,
			);
		}
		return { previewId: frame.previewId };
	}
	if (!UUID.test(frame.boxId)) {
		throw new RangeError(
			`tunnel open names boxId "${frame.boxId}", which is not a uuid`,
		);
	}
	if (frame.channel === "input")
		return { boxId: frame.boxId, channel: "input" };
	if (
		!Number.isInteger(frame.fps) ||
		frame.fps < TUNNEL_BOX_FPS.min ||
		frame.fps > TUNNEL_BOX_FPS.max
	) {
		throw new RangeError(
			`tunnel open names fps ${frame.fps}; a box view runs at ${TUNNEL_BOX_FPS.min}..${TUNNEL_BOX_FPS.max}`,
		);
	}
	return { boxId: frame.boxId, channel: "view", fps: frame.fps };
}

type OpenTarget = { previewId: string } | TunnelBoxTarget;

function openTarget(payload: Uint8Array): OpenTarget | null {
	try {
		const body: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(payload),
		);
		if (typeof body !== "object" || body === null) return null;
		const o = body as Record<string, unknown>;
		const keys = Object.keys(o).sort().join(",");
		if (keys === "previewId") {
			return typeof o.previewId === "string" && UUID.test(o.previewId)
				? { previewId: o.previewId }
				: null;
		}
		if (typeof o.boxId !== "string" || !UUID.test(o.boxId)) return null;
		if (keys === "boxId,channel" && o.channel === "input") {
			return { boxId: o.boxId, channel: "input" };
		}
		if (
			keys === "boxId,channel,fps" &&
			o.channel === "view" &&
			typeof o.fps === "number" &&
			Number.isInteger(o.fps) &&
			o.fps >= TUNNEL_BOX_FPS.min &&
			o.fps <= TUNNEL_BOX_FPS.max
		) {
			return { boxId: o.boxId, channel: "view", fps: o.fps };
		}
		return null;
	} catch {
		return null;
	}
}

const fault = (streamId: number | null, detail: string): TunnelDecodeFault => ({
	ok: false,
	streamId,
	detail,
});
