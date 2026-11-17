// ISS-1276 c4: an android box's view is scrcpy's H.264, decoded in the page with WebCodecs. A browser
// without them is told so by name and never handed a ticket for a view it cannot draw; the stream's
// bytes are reassembled into its header and packets whatever edges core's chunks cut them at.

import { BOX_ROUTES } from "@forge/contracts/boxes";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOX, projectBoxes } from "@/test/boxes";
import { fakeCore, renderWithQuery } from "@/test/render";
import { avcCodecOf, type ScrcpyHeader, type ScrcpyPacket, ScrcpyStream } from "../view/scrcpy";
import { BoxView } from "./box-view";

const android = projectBoxes().find((b) => b.id === BOX.android);
if (!android) throw new Error("no android box in the fixture");
const TICKET = BOX_ROUTES.ticket.replace(":id", BOX.android).replace(/^\/api/, "");

class FakeDecoder {
  static isConfigSupported = () => Promise.resolve({ supported: true });
  state = "unconfigured";
  configure() {}
  decode() {}
  close() {}
}

afterEach(() => vi.unstubAllGlobals());

describe("an android box's view", () => {
  it("names the missing WebCodecs where the browser lacks them, and asks for no ticket", () => {
    const calls = fakeCore(() => undefined);
    vi.stubGlobal("VideoDecoder", undefined);
    renderWithQuery(<BoxView box={android} label="ISS-12" fps={10} />);
    const fault = screen.getByTestId("box-view-fault");
    expect(fault).toHaveAttribute("data-fault", "no-webcodecs");
    expect(fault).toHaveTextContent("This browser can't show the Android view: it has no WebCodecs.");
    expect(calls).toEqual([]);
  });

  it("enters with a view ticket where the browser has WebCodecs", async () => {
    const calls = fakeCore((c) => (c.method === "POST" && c.path === TICKET ? { body: { ticket: "t", expiresAt: "2026-11-17T00:01:00Z", url: "/ws/boxes/view?ticket=t" } } : undefined));
    vi.stubGlobal("VideoDecoder", FakeDecoder);
    vi.stubGlobal("EncodedVideoChunk", class {});
    vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 0; send() {} close() {} });
    renderWithQuery(<BoxView box={android} label="ISS-12" fps={10} />);
    await waitFor(() => expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([["POST", TICKET, { channel: "view" }]]));
    expect(screen.queryByTestId("box-view-fault")).toBeNull();
    expect(screen.getByTestId("box-view")).toHaveAttribute("data-codec", "scrcpy-h264");
  });
});

/** The relayed stream: the 12-byte codec header, then each packet's 12-byte header and its bytes. */
function wire(packets: { high: number; low: number; data: number[] }[]): Uint8Array {
  const parts: number[] = [..."h264"].map((c) => c.charCodeAt(0));
  const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  parts.push(...u32(1080), ...u32(2400));
  for (const p of packets) parts.push(...u32(p.high), ...u32(p.low), ...u32(p.data.length), ...p.data);
  return Uint8Array.from(parts);
}

describe("the scrcpy stream", () => {
  const SPS = [0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xaa];
  const bytes = wire([
    { high: 0x8000_0000, low: 0, data: SPS },
    { high: 0x4000_0000, low: 33_000, data: [0, 0, 0, 1, 0x65, 1, 2, 3] },
    { high: 0x0000_0001, low: 5, data: [0, 0, 0, 1, 0x41, 9] },
  ]);

  it("reads its header and each packet's flags, time and bytes, whatever edges the chunks are cut at", () => {
    for (const cut of [1, 5, 12, 13, 23, bytes.length]) {
      const headers: ScrcpyHeader[] = [];
      const packets: ScrcpyPacket[] = [];
      const stream = new ScrcpyStream((h) => headers.push(h), (p) => packets.push(p));
      for (let at = 0; at < bytes.length; at += cut) stream.push(bytes.slice(at, at + cut));
      expect(headers).toEqual([{ codec: "h264", width: 1080, height: 2400 }]);
      expect(packets.map((p) => [p.config, p.key, p.pts, [...p.data]])).toEqual([
        [true, false, 0, SPS],
        [false, true, 33_000, [0, 0, 0, 1, 0x65, 1, 2, 3]],
        [false, false, 2 ** 32 + 5, [0, 0, 0, 1, 0x41, 9]],
      ]);
    }
  });

  it("names the decoder's codec from the SPS in a config packet, and none where it holds no SPS", () => {
    expect(avcCodecOf(Uint8Array.from(SPS))).toBe("avc1.42c01f");
    expect(avcCodecOf(Uint8Array.from([0, 0, 0, 1, 0x68, 1, 2, 3]))).toBeNull();
  });
});
