// An android box's view (`scrcpy-h264`, ISS-1276): the runner relays scrcpy's video socket with the
// dummy byte stripped and device meta off, so the stream is a 12-byte codec header ("h264", width,
// height, big-endian) and then, per packet, a 12-byte header (pts with the config and key flags in
// its top bits, then the size) and the packet, Annex B. Core relays it as binary chunks that do not
// line up with packets, so the bytes are reassembled here. The page decodes it with WebCodecs; a
// browser without them is told so by name, never shown a blank screen.

const CODEC_HEADER = 12;
const PACKET_HEADER = 12;
// the pts word's top two bits, read from its high 32 bits: config, then key frame
const CONFIG_BIT = 0x8000_0000;
const KEY_BIT = 0x4000_0000;
const PTS_HIGH = 0x3fff_ffff;

export interface ScrcpyPacket {
  config: boolean;
  key: boolean;
  /** Microseconds; 0 for a config packet. */
  pts: number;
  data: Uint8Array;
}

export interface ScrcpyHeader {
  codec: string;
  width: number;
  height: number;
}

/** Reassembles the relayed byte stream into its header and packets, whatever the chunks' edges. */
export class ScrcpyStream {
  private buf = new Uint8Array(0);
  private header: ScrcpyHeader | null = null;

  constructor(
    private readonly onHeader: (h: ScrcpyHeader) => void,
    private readonly onPacket: (p: ScrcpyPacket) => void,
  ) {}

  push(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;
    let at = 0;
    const view = new DataView(this.buf.buffer);
    if (!this.header) {
      if (this.buf.length < CODEC_HEADER) return;
      const codec = new TextDecoder().decode(this.buf.subarray(0, 4));
      this.header = { codec, width: view.getUint32(4), height: view.getUint32(8) };
      at = CODEC_HEADER;
      this.onHeader(this.header);
    }
    while (this.buf.length - at >= PACKET_HEADER) {
      const high = view.getUint32(at);
      const low = view.getUint32(at + 4);
      const size = view.getUint32(at + 8);
      if (this.buf.length - at - PACKET_HEADER < size) break;
      const data = this.buf.slice(at + PACKET_HEADER, at + PACKET_HEADER + size);
      this.onPacket({ config: (high & CONFIG_BIT) !== 0, key: (high & KEY_BIT) !== 0, pts: (high & PTS_HIGH) * 2 ** 32 + low, data });
      at += PACKET_HEADER + size;
    }
    this.buf = this.buf.slice(at);
  }
}

/** The WebCodecs codec string (`avc1.PPCCLL`) the SPS inside an Annex B config packet names. */
export function avcCodecOf(config: Uint8Array): string | null {
  for (let i = 0; i + 4 < config.length; i++) {
    const three = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1;
    if (!three) continue;
    const nal = config[i + 3] ?? 0;
    if ((nal & 0x1f) === 7 && i + 6 < config.length) {
      const hex = (b: number | undefined) => (b ?? 0).toString(16).padStart(2, "0");
      return `avc1.${hex(config[i + 4])}${hex(config[i + 5])}${hex(config[i + 6])}`;
    }
  }
  return null;
}

/** Why this browser cannot show an android box, or null when it can try. */
export type DecodeFault = { kind: "no-webcodecs" } | { kind: "unsupported"; codec: string };

export function webCodecsMissing(): DecodeFault | null {
  return typeof globalThis.VideoDecoder === "function" && typeof globalThis.EncodedVideoChunk === "function" ? null : { kind: "no-webcodecs" };
}

/**
 * Decodes the stream onto `canvas`. Each config packet (SPS and PPS) configures the decoder and is
 * carried in front of the next frame, as scrcpy's own client does; frames before the first key frame
 * are dropped, since a decoder cannot start on a delta.
 */
export function h264Sink(canvas: HTMLCanvasElement, onFault: (f: DecodeFault) => void) {
  const missing = webCodecsMissing();
  if (missing) {
    onFault(missing);
    return { push: () => undefined, close: () => undefined };
  }
  const ctx = canvas.getContext("2d");
  const decoder = new VideoDecoder({
    output: (frame) => {
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      ctx?.drawImage(frame, 0, 0);
      frame.close();
    },
    error: () => onFault({ kind: "unsupported", codec: "h264" }),
  });
  let pendingConfig: Uint8Array | null = null;
  let started = false;
  const stream = new ScrcpyStream(
    () => undefined,
    (p) => {
      if (p.config) {
        const codec = avcCodecOf(p.data);
        if (!codec) return;
        pendingConfig = p.data;
        void VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true }).then((s) => {
          if (!s.supported) onFault({ kind: "unsupported", codec });
        });
        decoder.configure({ codec, optimizeForLatency: true });
        started = false;
        return;
      }
      if (decoder.state !== "configured" || (!started && !p.key)) return;
      started = true;
      let data = p.data;
      if (pendingConfig) {
        data = new Uint8Array(pendingConfig.length + p.data.length);
        data.set(pendingConfig);
        data.set(p.data, pendingConfig.length);
        pendingConfig = null;
      }
      decoder.decode(new EncodedVideoChunk({ type: p.key ? "key" : "delta", timestamp: p.pts, data }));
    },
  );
  return {
    push: (chunk: Uint8Array) => stream.push(chunk),
    close: () => {
      if (decoder.state !== "closed") decoder.close();
    },
  };
}
