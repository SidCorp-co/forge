// A box at its own address, `/projects/<slug>/boxes/<box id>` (ISS-1325): its screen alone, full
// viewport, with the bar the full screen keeps, so a link from an issue, a release, a posted message
// or a phone opens straight on the screen. A closed box says so and plays its clip where a span kept
// one; a box the reader may not see is refused with core's own words for why. Exit opens the Boxes
// page on it. It moves live on its project's room, as the page does.

import { BOX_LIMITS, type BoxRecord, type BoxSpanRecord } from "@forge/contracts/boxes";
import { useState } from "react";
import { LoadingState, PageContainer, SegmentedControl } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRouter } from "@/lib/navigation/router";
import { captionsOf } from "@/lib/utils/captions";
import { useMediaSrc } from "@/lib/utils/use-media-src";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useAuth } from "@/providers/auth-provider";
import { useBox, useBoxSpans } from "../hooks";
import { isEnded } from "../labels";
import { boxesPageHref } from "../links";
import { useBoxLabel } from "./box-list";
import { BoxScreen } from "./box-screen";

/** Where core serves a span's clip: an issue attachment, read with the session. */
const clipUrl = (span: BoxSpanRecord) => `/api/attachments/${span.clipAttachmentId}/download`;

function Clip({ span, label }: { span: BoxSpanRecord; label: string }) {
  const src = useMediaSrc(clipUrl(span), true);
  if (src.state !== "ready") return null;
  return (
    // a QA screen recording has no spoken words: its captions are its text alternative
    <video className="min-h-0 max-w-full flex-1 rounded-md" src={src.src} controls playsInline muted aria-label={label} data-testid="box-clip">
      <track kind="captions" src={captionsOf(label)} label={label} default />
    </video>
  );
}

/** A box that ended: closed or failed, in one line, and the clips its spans kept, the newest first. */
function Ended({ box, label }: { box: BoxRecord; label: string }) {
  const t = useCopy();
  const clips = (useBoxSpans(box.id).data ?? []).filter((s) => s.clipAttachmentId).reverse();
  const [picked, setPicked] = useState<string | null>(null);
  const shown = clips.find((s) => s.id === picked) ?? clips[0];
  const why = box.failure ? t(`boxes.failure.${box.failure}`) : box.closedWhy === "idle" ? t("boxes.closedWhy.idle") : null;
  return (
    <div className="flex size-full min-h-0 flex-col items-center gap-3" data-testid="box-ended" data-state={box.state}>
      <p className="text-14 font-semibold">{[t(box.state === "failed" ? "boxes.screen.failed" : "boxes.screen.closed"), why].filter(Boolean).join(" · ")}</p>
      {clips.length > 1 ? (
        <SegmentedControl value={shown?.id ?? ""} onChange={setPicked} options={clips.map((s) => ({ value: s.id, label: t("boxes.row.criterion", { n: s.criterion }) }))} />
      ) : null}
      {shown ? <Clip key={shown.id} span={shown} label={`${label} · ${t("boxes.row.criterion", { n: shown.criterion })}`} /> : <p className="text-13 text-muted">{t("boxes.screen.noClip")}</p>}
    </div>
  );
}

function Alone({ box, slug, canWrite }: { box: BoxRecord; slug: string; canWrite: boolean }) {
  const me = useAuth().user?.id;
  const router = useRouter();
  const label = useBoxLabel(box);
  const [fps, setFps] = useState<number>(BOX_LIMITS.viewFpsDefault);
  useRoom(box.projectId ? projectRoom(box.projectId) : null);
  return (
    <BoxScreen
      box={box}
      projectId={box.projectId ?? ""}
      label={label}
      me={me}
      canWrite={canWrite}
      fps={fps}
      onFps={setFps}
      onExit={() => router.push(boxesPageHref(slug, box.id))}
      idle={isEnded(box) ? <Ended box={box} label={label} /> : undefined}
    />
  );
}

/** The box `boxId` alone; `canWriteIn` says whether the reader may write in the box's project. */
export function BoxAlone({ boxId, slug, canWriteIn }: { boxId: string; slug: string; canWriteIn: (projectId: string) => boolean }) {
  const t = useCopy();
  const boxQ = useBox(boxId);
  if (boxQ.isError) {
    return (
      <PageContainer className="grid gap-2" data-testid="box-alone-refused">
        <p className="text-14 font-semibold">{t("boxes.screen.refused")}</p>
        <RefusalLine error={boxQ.error} testid="box-alone-refusal" />
      </PageContainer>
    );
  }
  if (!boxQ.data) return <LoadingState label={t("boxes.title")} />;
  const box = boxQ.data;
  return <Alone box={box} slug={slug} canWrite={!!box.projectId && canWriteIn(box.projectId)} />;
}
