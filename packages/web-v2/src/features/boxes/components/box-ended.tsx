// A box that ended (ISS-1325, ISS-1338): closed or failed in one line, and what it kept to watch: the
// whole session a person asked to record and each span's clip, a press apart in one switch. A session
// recording on its way, or one that could not come, says so in its own words, the why on hover; one
// kept on the device that Forge was never sent (recorded before it was, or by a runner that does not
// send it) says it stayed there; a box that kept nothing says No clip only where nothing else is said.

import type { BoxRecord, BoxSessionRecording } from "@forge/contracts/boxes";
import { useState } from "react";
import { SegmentedControl } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { captionsOf } from "@/lib/utils/captions";
import { useMediaSrc } from "@/lib/utils/use-media-src";
import { useBoxSpans } from "../hooks";

/** The switch's value for the whole session, beside each span's id. */
const SESSION = "session";

/** Where core serves a clip: an issue attachment, read with the session. */
const attachmentUrl = (id: string) => `/api/attachments/${id}/download`;

function Clip({ attachmentId, label }: { attachmentId: string; label: string }) {
  const src = useMediaSrc(attachmentUrl(attachmentId), true);
  if (src.state !== "ready") return null;
  return (
    // a QA screen recording has no spoken words: its captions are its text alternative
    <video className="min-h-0 max-w-full flex-1 rounded-md" src={src.src} controls playsInline muted aria-label={label} data-testid="box-clip">
      <track kind="captions" src={captionsOf(label)} label={label} default />
    </video>
  );
}

/** The session recording where it is not there to play: on its way, or why it could not come. */
function SessionLine({ session }: { session: BoxSessionRecording }) {
  const t = useCopy();
  const words = session.state === "failed" && session.fault ? t(`boxes.session.fault.${session.fault}`) : t("boxes.session.sending");
  return (
    <p className="text-13 text-muted" title={session.detail ?? undefined} data-testid="box-session" data-state={session.state} data-fault={session.fault ?? undefined}>
      {`${t("boxes.session.label")} · ${words}`}
    </p>
  );
}

export function BoxEnded({ box, label }: { box: BoxRecord; label: string }) {
  const t = useCopy();
  const spans = (useBoxSpans(box.id).data ?? []).filter((s) => s.clipAttachmentId).reverse();
  const session = box.recording?.session ?? null;
  const sessionClip = session?.state === "attached" ? session.clipAttachmentId : null;
  const options = [
    ...(sessionClip ? [{ value: SESSION, label: t("boxes.session.label"), attachmentId: sessionClip }] : []),
    ...spans.map((s) => ({ value: s.id, label: t("boxes.row.criterion", { n: s.criterion }), attachmentId: s.clipAttachmentId ?? "" })),
  ];
  const [picked, setPicked] = useState<string | null>(null);
  const shown = options.find((o) => o.value === picked) ?? options[0];
  const why = box.failure ? t(`boxes.failure.${box.failure}`) : box.closedWhy === "idle" ? t("boxes.closedWhy.idle") : null;
  const onDevice = !session && box.recording?.state === "kept";
  const missing =
    session && session.state !== "attached" ? (
      <SessionLine session={session} />
    ) : onDevice ? (
      <p className="text-13 text-muted" title={t("boxes.session.onDeviceWhy")} data-testid="box-session" data-state="on-device">
        {`${t("boxes.session.label")} · ${t("boxes.session.onDevice")}`}
      </p>
    ) : null;
  return (
    <div className="flex size-full min-h-0 flex-col items-center gap-3" data-testid="box-ended" data-state={box.state}>
      <p className="text-14 font-semibold">{[t(box.state === "failed" ? "boxes.screen.failed" : "boxes.screen.closed"), why].filter(Boolean).join(" · ")}</p>
      {options.length > 1 ? <SegmentedControl value={shown?.value ?? ""} onChange={setPicked} options={options.map(({ value, label: l }) => ({ value, label: l }))} /> : null}
      {shown ? <Clip key={shown.value} attachmentId={shown.attachmentId} label={`${label} · ${shown.label}`} /> : null}
      {missing}
      {!shown && !missing ? <p className="text-13 text-muted">{t("boxes.screen.noClip")}</p> : null}
    </div>
  );
}
