// A box's live view (ISS-1276 c4): entered with a one-minute ticket for the view socket, watch-only,
// at this viewer's own frame rate. Each codec draws in the page: agent-browser's JPEG frames into an
// image, scrcpy's H.264 through WebCodecs onto a canvas, x11vnc's RFB through noVNC. A browser that
// cannot decode the android view is told so by name and never shown a blank screen. As the preview
// frame does, a reload enters again from nothing: the entry is keyed by the box, the rate and a round.

import { BOX_VIEW_CODECS, type BoxViewCodec } from "@forge/contracts/box-wire";
import type { BoxRecord } from "@forge/contracts/boxes";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/design";
import { RefusedLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { boxSocketUrl } from "../api";
import { boxQueries } from "../queries";
import { type DecodeFault, h264Sink, webCodecsMissing } from "../view/scrcpy";
import { jpegOf, openViewer, rfbChannel } from "../view/viewer";

interface ViewProps {
  box: BoxRecord;
  label: string;
  fps: number;
  /** Drawn over the screen, in its exact bounds: the holder's input layer. */
  overlay?: ReactNode;
  /**
   * `page`: as wide as fits and never taller than most of the window. `screen`: as large as fits in
   * its nearest size container whole (full screen, the box's own address), its shape kept.
   */
  fit?: "page" | "screen";
}

/** The screen's box: the box's own shape, at the size its place gives it, so the input layer over it maps 0..1 to the box exactly. */
function screenStyle(size: { width: number; height: number } | null | undefined, fit: "page" | "screen") {
  const [w, h] = size ? [size.width, size.height] : [16, 9];
  const width = fit === "screen" ? `min(100cqw, calc(100cqh * ${w} / ${h}))` : size ? `min(100%, calc(70vh * ${w} / ${h}))` : "100%";
  return { aspectRatio: `${w} / ${h}`, width };
}

export function BoxView(props: ViewProps) {
  const [round, setRound] = useState(0);
  const codec: BoxViewCodec = (props.box.view?.codec as BoxViewCodec | undefined) ?? BOX_VIEW_CODECS[props.box.mode];
  const missing = codec === "scrcpy-h264" ? webCodecsMissing() : null;
  if (missing) return <Fault fault={missing} />;
  return <ViewEntry key={`${props.box.id}|${props.fps}|${round}`} {...props} codec={codec} round={round} onReconnect={() => setRound((n) => n + 1)} />;
}

function Fault({ fault }: { fault: DecodeFault }) {
  const t = useCopy();
  return (
    <p role="alert" className="grid aspect-video place-items-center bg-neutral-12 p-6 text-center text-13 text-neutral-1" data-testid="box-view-fault" data-fault={fault.kind}>
      {fault.kind === "no-webcodecs" ? t("boxes.view.webCodecsMissing") : t("boxes.view.codecUnsupported", { codec: fault.codec })}
    </p>
  );
}

type Phase = { at: "connecting" } | { at: "live"; width: number; height: number } | { at: "ended"; why: string };

/** Opens the view socket once the ticket answers, and routes each codec's bytes to its drawing. */
function useViewSocket(url: string | null, codec: BoxViewCodec, fps: number, refs: { img: HTMLImageElement | null; canvas: HTMLCanvasElement | null; rfb: HTMLDivElement | null }, onFault: (f: DecodeFault) => void) {
  const [phase, setPhase] = useState<Phase>({ at: "connecting" });
  useEffect(() => {
    if (!url) return;
    const sink = codec === "scrcpy-h264" && refs.canvas ? h264Sink(refs.canvas, onFault) : null;
    let channel: ReturnType<typeof rfbChannel> | null = null;
    let rfb: { disconnect: () => void } | null = null;
    const early: ArrayBuffer[] = [];
    const viewer = openViewer(boxSocketUrl(url, fps), {
      hello: (m) => setPhase({ at: "live", width: m.width, height: m.height }),
      holder: () => undefined,
      ended: (why) => {
        channel?.end(why);
        setPhase({ at: "ended", why });
      },
      text: (data) => {
        const src = codec === "jpeg-frames" ? jpegOf(data) : null;
        if (src && refs.img) refs.img.src = src;
      },
      binary: (data) => {
        if (sink) sink.push(new Uint8Array(data));
        else if (channel) channel.deliver(data);
        else if (codec === "rfb") early.push(data);
      },
    });
    if (codec === "rfb" && refs.rfb) {
      const target = refs.rfb;
      void import("@novnc/novnc").then(({ default: RFB }) => {
        channel = rfbChannel(viewer);
        const client = new RFB(target, channel, { shared: true });
        client.viewOnly = true;
        client.scaleViewport = true;
        rfb = client;
        for (const data of early.splice(0)) channel.deliver(data);
      });
    }
    return () => {
      rfb?.disconnect();
      sink?.close();
      viewer.close();
    };
  }, [url, codec, fps, refs.img, refs.canvas, refs.rfb, onFault]);
  return phase;
}

function ViewEntry({ box, label, fps, overlay, fit = "page", codec, round, onReconnect }: ViewProps & { codec: BoxViewCodec; round: number; onReconnect: () => void }) {
  const t = useCopy();
  const ticket = useQuery(boxQueries.ticket(box.id, "view", `${fps}|${round}`));
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [rfbTarget, setRfbTarget] = useState<HTMLDivElement | null>(null);
  const [fault, setFault] = useState<DecodeFault | null>(null);
  const onFault = useRef((f: DecodeFault) => setFault(f)).current;
  const phase = useViewSocket(ticket.data?.url ?? null, codec, fps, { img, canvas, rfb: rfbTarget }, onFault);
  if (fault) return <Fault fault={fault} />;
  const size = phase.at === "live" && phase.width > 0 ? phase : (box.view ?? box.viewport);
  const known = ["jpeg-frames", "scrcpy-h264", "rfb"].includes(codec);
  return (
    <div className="grid gap-2" data-testid="box-view" data-codec={codec} data-phase={phase.at} data-fit={fit}>
      <RefusedLine label={t("boxes.view.ticketFailed")} error={ticket.error} className="text-13 text-danger-11" />
      <div className="relative mx-auto bg-neutral-12" style={screenStyle(size, fit)}>
        {!known ? <p className="p-4 text-13 text-neutral-1">{t("boxes.view.unknownCodec", { codec })}</p> : null}
        {codec === "jpeg-frames" ? <img ref={setImg} alt={t("boxes.view.title", { box: label })} className="absolute inset-0 size-full object-contain" /> : null}
        {codec === "scrcpy-h264" ? <canvas ref={setCanvas} aria-label={t("boxes.view.title", { box: label })} className="absolute inset-0 size-full object-contain" /> : null}
        {codec === "rfb" ? <div ref={setRfbTarget} role="img" aria-label={t("boxes.view.title", { box: label })} className="absolute inset-0 size-full" /> : null}
        {phase.at === "connecting" && !ticket.error ? (
          <p role="status" className="absolute inset-0 grid place-items-center text-13 text-neutral-1">
            {t("boxes.view.connecting")}
          </p>
        ) : null}
        {phase.at === "live" ? overlay : null}
      </div>
      {phase.at === "ended" ? (
        <p role="status" className="flex flex-wrap items-center gap-2 text-13 text-muted" data-testid="box-view-ended">
          {t("boxes.view.ended", { why: phase.why })}
          <Button size="sm" variant="ghost" onClick={onReconnect}>
            {t("boxes.view.reconnect")}
          </Button>
        </p>
      ) : null}
    </div>
  );
}
