// A box at its own address, `/projects/<slug>/boxes/<box id>` (ISS-1325): its screen alone, full
// viewport, with the bar the full screen keeps, so a link from an issue, a release, a posted message
// or a phone opens straight on the screen. A closed box says so and plays its session recording and
// its spans' clips (`BoxEnded`, ISS-1338); a box the reader may not see, or an address naming none,
// says why in a few words of its own, core's code on hover, never a raw id. Exit opens the Boxes
// page on it. It moves live on its project's room, as the page does.

import { BOX_LIMITS, type BoxRecord } from "@forge/contracts/boxes";
import { useState } from "react";
import { LoadingState, PageContainer } from "@/design";
import { ApiError } from "@/lib/api/client";
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

/** Why a box read was refused, as the screen words it: core's detail names raw ids, so it stays off the page (ISS-1325 c5). */
function refusedWhy(err: unknown): "notFound" | "badLink" | "noAccess" | "unavailable" {
  if (!(err instanceof ApiError)) return "unavailable";
  if (err.status === 404) return "notFound";
  if (err.status === 400) return "badLink";
  if (err.status === 401 || err.status === 403) return "noAccess";
  return "unavailable";
}

const refusedCode = (err: unknown): string | null => (err instanceof ApiError ? (err.code ?? null) : null);

/** The box `boxId` alone; `canWriteIn` says whether the reader may write in the box's project. */
export function BoxAlone({ boxId, slug, canWriteIn }: { boxId: string; slug: string; canWriteIn: (projectId: string) => boolean }) {
  const t = useCopy();
  const boxQ = useBox(boxId);
  if (boxQ.isError) {
    return (
      <PageContainer className="grid gap-2" data-testid="box-alone-refused">
        <p className="text-14 font-semibold">{t("boxes.screen.refused")}</p>
        <p className="fg-caption" title={refusedCode(boxQ.error) ?? undefined} data-testid="box-alone-refusal">
          {t(`boxes.screen.refusedWhy.${refusedWhy(boxQ.error)}`)}
        </p>
      </PageContainer>
    );
  }
  if (!boxQ.data) return <LoadingState label={t("boxes.title")} />;
  const box = boxQ.data;
  return <Alone box={box} slug={slug} canWrite={!!box.projectId && canWriteIn(box.projectId)} />;
}
