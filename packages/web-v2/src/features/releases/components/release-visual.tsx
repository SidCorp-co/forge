// What a release line shows (ISS-1308, mockup MK-13): the clip or shots its judge marked, in a
// desktop frame at 16:10 and a phone frame at 9:19.5, a clip on its still with a play mark and its
// length, and any of them opened large in a lightbox. In the app each file is fetched with the
// session; on a share link it plays from its own short-lived ticket (`use-media-src.ts`).

import type { ReleaseLineVisual, ReleaseVisualFile } from "@forge/contracts/release-page";
import { useState } from "react";
import { DeviceFrame, type DeviceFrameKind, DeviceFrames, MediaOverlay, PhoneStage, PlayMark, SegmentedControl, Skeleton, ThumbSlot } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { captionsOf } from "@/lib/utils/captions";
import { useMediaSrc } from "@/lib/utils/use-media-src";

type Frame = "desktop" | "phone";

/** A clip's length as a reader reads it: 0:20, 12:05. */
export const lengthOf = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.round(seconds) % 60).padStart(2, "0")}`;

/** What a clip's play mark says: a lead word where one is given, then its length where it is known. */
export const playWords = (seconds: number | null, lead?: string): string => [lead, seconds !== null ? lengthOf(seconds) : null].filter(Boolean).join(" ");

/** The picture a frame shows: a picture as itself, a clip as its still, or its first frame where none was kept. */
function FramePicture({ file, still, authed }: { file: ReleaseVisualFile; still: ReleaseVisualFile | null; authed: boolean }) {
  const clip = file.kind === "clip";
  const shown = useMediaSrc(clip && still ? still.url : file.url, authed);
  if (shown.state === "loading") return <Skeleton className="absolute inset-0" />;
  if (shown.state === "lost") return null;
  if (clip && !still) return <video className="absolute inset-0 size-full object-cover object-top" src={`${shown.src}#t=0.1`} muted playsInline preload="metadata" aria-hidden />;
  return <img className="absolute inset-0 size-full object-cover object-top" src={shown.src} alt="" />;
}

/** The lightbox a frame opens: the clip playing with its controls, or the picture whole. */
function Lightbox({ file, label, authed, onClose }: { file: ReleaseVisualFile; label: string; authed: boolean; onClose: () => void }) {
  const t = useCopy();
  const src = useMediaSrc(file.url, authed);
  return (
    <MediaOverlay open onOpenChange={(o) => (o ? null : onClose())} label={label}>
      <div className="flex justify-end p-4">
        <button type="button" className="rounded-md bg-surface px-3 py-1.5 text-13 text-fg" onClick={onClose} data-testid="visual-lightbox-close">
          {t("releases.visual.close")}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 pt-0" data-testid="visual-lightbox">
        {src.state !== "ready" ? null : file.kind === "clip" ? (
          // a QA screen recording has no spoken words: its captions are its text alternative
          <video className="max-h-full max-w-full rounded-md" src={src.src} controls autoPlay muted playsInline aria-label={label}>
            <track kind="captions" src={captionsOf(label)} label={label} default />
          </video>
        ) : (
          <img className="max-h-full max-w-full rounded-md object-contain" src={src.src} alt={label} />
        )}
      </div>
    </MediaOverlay>
  );
}

/** One frame of a line's visual, opening its file in the lightbox. */
export function VisualTile({ visual, frame, kind, authed, label, lead }: {
  visual: ReleaseLineVisual;
  frame: Frame;
  kind?: DeviceFrameKind;
  authed: boolean;
  label: string;
  lead?: string;
}) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const file = visual[frame];
  if (!file) return null;
  const clip = file.kind === "clip";
  return (
    <>
      <DeviceFrame kind={kind ?? frame} label={t(clip ? "releases.visual.play" : "releases.visual.open", { what: label })} onPress={() => setOpen(true)} testId="visual-frame" dataKind={file.kind}>
        <FramePicture file={file} still={visual.still} authed={authed} />
        {clip ? <PlayMark small={kind === "thumb"}>{kind === "thumb" ? null : playWords(visual.seconds, lead)}</PlayMark> : null}
      </DeviceFrame>
      {open ? <Lightbox file={file} label={label} authed={authed} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The frames a line shows: Desktop sets its phone frame beside its desktop one; Phone shows the phone alone. */
export function LineVisual({ visual, authed, label }: { visual: ReleaseLineVisual; authed: boolean; label: string }) {
  const t = useCopy();
  const both = visual.desktop !== null && visual.phone !== null;
  const [frame, setFrame] = useState<Frame>(visual.desktop ? "desktop" : "phone");
  const tile = (f: Frame) => <VisualTile visual={visual} frame={f} authed={authed} label={label} />;
  return (
    <div className="grid content-start gap-2" data-testid="line-visual" data-frame={frame}>
      {both ? (
        <div>
          <SegmentedControl<Frame>
            value={frame}
            onChange={setFrame}
            options={[
              { value: "desktop", label: t("releases.visual.desktop") },
              { value: "phone", label: t("releases.visual.phone") },
            ]}
          />
        </div>
      ) : null}
      {frame === "desktop" ? <DeviceFrames desktop={tile("desktop")} phone={visual.phone ? tile("phone") : undefined} /> : <PhoneStage>{tile("phone")}</PhoneStage>}
    </div>
  );
}

/** A Fixed row's thumbnail: its visual's first frame, small. */
export function VisualThumb({ visual, authed, label }: { visual: ReleaseLineVisual; authed: boolean; label: string }) {
  return (
    <ThumbSlot>
      <VisualTile visual={visual} frame={visual.desktop ? "desktop" : "phone"} kind="thumb" authed={authed} label={label} />
    </ThumbSlot>
  );
}
