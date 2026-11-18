// A box at its own address, `/projects/<slug>/boxes/<box id>` (ISS-1325): its screen alone, full
// viewport, with the bar the full screen keeps, so a link from an issue, a release, a posted message
// or a phone opens straight on the screen. A closed box says so and plays its session recording and
// its spans' clips (`BoxEnded`, ISS-1338); a box the reader may not see is refused with core's own
// words for why. Exit opens the Boxes
// page on it. It moves live on its project's room, as the page does.

import { BOX_LIMITS, type BoxRecord } from "@forge/contracts/boxes";
import { useState } from "react";
import { LoadingState, PageContainer } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRouter } from "@/lib/navigation/router";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useAuth } from "@/providers/auth-provider";
import { useBox } from "../hooks";
import { isEnded } from "../labels";
import { boxesPageHref } from "../links";
import { BoxEnded } from "./box-ended";
import { useBoxLabel } from "./box-list";
import { BoxScreen } from "./box-screen";

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
      idle={isEnded(box) ? <BoxEnded box={box} label={label} /> : undefined}
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
