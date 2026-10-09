import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/preview-tunnel-frames.json" with {
	type: "json",
};
import {
	decodeTunnelFrame,
	encodeTunnelFrame,
	TUNNEL_LIMITS,
	type TunnelFrame,
} from "./preview-tunnel.js";

const fromHex = (hex: string) =>
	Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

type FixtureFrame = (typeof fixtures.frames)[number]["frame"];

/** The fixture's JSON form of a frame: bytes travel as hex so the file stays readable to Rust and TS. */
function frameOf(f: FixtureFrame): TunnelFrame {
	if ("bytesHex" in f)
		return { type: "data", streamId: f.streamId, bytes: fromHex(f.bytesHex) };
	return f as TunnelFrame;
}

describe("the tunnel frames both codecs hold to (BC-5)", () => {
	it.each(fixtures.frames)(
		"$name decodes to its frame and encodes back to the same bytes",
		({ hex, frame }) => {
			const decoded = decodeTunnelFrame(fromHex(hex));
			expect(decoded).toEqual({ ok: true, frame: frameOf(frame) });
			expect(toHex(encodeTunnelFrame(frameOf(frame)))).toBe(hex);
		},
	);

	it.each(fixtures.faults)(
		"$name is refused, naming the stream where the header names one",
		({ hex, streamId }) => {
			const decoded = decodeTunnelFrame(fromHex(hex));
			expect(decoded).toMatchObject({ ok: false, streamId });
			expect(decoded.ok === false && decoded.detail.length > 0).toBe(true);
		},
	);

	it("decodes a frame read from the middle of a larger buffer, as a Node Buffer pool hands it", () => {
		const frame = fromHex(fixtures.frames[1]?.hex ?? "");
		const pooled = new Uint8Array(frame.byteLength + 7);
		pooled.set(frame, 5);
		expect(
			decodeTunnelFrame(pooled.subarray(5, 5 + frame.byteLength)),
		).toMatchObject({
			ok: true,
			frame: { type: "data", streamId: 3 },
		});
	});
});

describe("the tunnel's limits", () => {
	it("carries a data frame of exactly the most bytes one may, and refuses one byte more", () => {
		const full = new Uint8Array(TUNNEL_LIMITS.maxDataBytes).fill(7);
		const encoded = encodeTunnelFrame({
			type: "data",
			streamId: 9,
			bytes: full,
		});
		expect(decodeTunnelFrame(encoded)).toMatchObject({
			ok: true,
			frame: { type: "data", streamId: 9 },
		});

		const over = new Uint8Array(TUNNEL_LIMITS.maxDataBytes + 1);
		expect(() =>
			encodeTunnelFrame({ type: "data", streamId: 9, bytes: over }),
		).toThrow("tunnel data frame carries 65537 bytes; one carries 1..65536");
		const forged = new Uint8Array(12 + over.byteLength);
		forged.set(encoded.subarray(0, 12));
		new DataView(forged.buffer).setUint32(8, over.byteLength);
		expect(decodeTunnelFrame(forged)).toEqual({
			ok: false,
			streamId: 9,
			detail: "tunnel data frame carries 65537 bytes; one carries 1..65536",
		});
	});

	it("refuses an open payload past its cap", () => {
		const big = new TextEncoder().encode(
			JSON.stringify({ previewId: "x".repeat(TUNNEL_LIMITS.maxOpenBytes) }),
		);
		const message = new Uint8Array(12 + big.byteLength);
		const view = new DataView(message.buffer);
		view.setUint8(0, 1);
		view.setUint8(1, 1);
		view.setUint32(4, 1);
		view.setUint32(8, big.byteLength);
		message.set(big, 12);
		expect(decodeTunnelFrame(message)).toMatchObject({
			ok: false,
			streamId: 1,
		});
	});

	it("will not encode stream 0, a stream past 32 bits, an empty window or a preview that is not a uuid", () => {
		expect(() => encodeTunnelFrame({ type: "close", streamId: 0 })).toThrow(
			RangeError,
		);
		expect(() =>
			encodeTunnelFrame({ type: "close", streamId: 2 ** 32 }),
		).toThrow(RangeError);
		expect(() =>
			encodeTunnelFrame({ type: "window", streamId: 1, delta: 0 }),
		).toThrow(RangeError);
		expect(() =>
			encodeTunnelFrame({ type: "open", streamId: 1, previewId: "p-1" }),
		).toThrow(RangeError);
		expect(() =>
			encodeTunnelFrame({
				type: "data",
				streamId: 1,
				bytes: new Uint8Array(0),
			}),
		).toThrow(RangeError);
	});

	it("starts each stream with yamux's window and grants back at half of it", () => {
		expect(TUNNEL_LIMITS.initialWindow).toBe(256 * 1024);
		expect(TUNNEL_LIMITS.windowUpdateAt).toBe(TUNNEL_LIMITS.initialWindow / 2);
		expect(TUNNEL_LIMITS.maxDataBytes).toBeLessThan(
			TUNNEL_LIMITS.initialWindow,
		);
	});
});
