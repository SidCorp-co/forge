// A project's Boxes page (ISS-1276 c7, mockup MK-12): it opens on its overview, then the boxes and the
// waiting queue beside the selected box's live view, its command feed and its criteria. The selected
// box rides the address (`?box=`), so a link from an issue opens on it. Everything moves live on the
// project room's `box.changed`.

import type { BoxRecord } from "@forge/contracts/boxes";
import { ErrorState, LoadingState, PageContainer, PageTitle, useUrlParams } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useAuth } from "@/providers/auth-provider";
import { useProjectBoxes } from "../hooks";
import { isLive } from "../labels";
import { BoxList, BoxQueue, useBoxLabel } from "./box-list";
import { BoxLive } from "./box-live";
import { BoxOpen } from "./box-open";
import { BoxesBand } from "./boxes-band";

/** The `?box=` param the page selects by. */
export const BOX_PARAM = "box";

function Selected({ box, projectId, me, canWrite }: { box: BoxRecord; projectId: string; me: string | undefined; canWrite: boolean }) {
  const label = useBoxLabel(box);
  return <BoxLive box={box} projectId={projectId} label={label} me={me} canWrite={canWrite} />;
}

/** The box the address names, else the first one live, else the first listed. */
function pick(boxes: readonly BoxRecord[], named: string | null): BoxRecord | null {
  return boxes.find((b) => b.id === named) ?? boxes.find(isLive) ?? boxes.find((b) => b.state !== "waiting") ?? null;
}

export function BoxesScreen({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const t = useCopy();
  const me = useAuth().user?.id;
  useRoom(projectRoom(projectId));
  const boxesQ = useProjectBoxes(projectId);
  const [params, setParams] = useUrlParams();
  const select = (id: string) => setParams({ [BOX_PARAM]: id });
  const boxes = boxesQ.data ?? [];
  const selected = pick(boxes, params.get(BOX_PARAM));
  return (
    <PageContainer className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>{t("boxes.title")}</PageTitle>
        {canWrite ? <BoxOpen projectId={projectId} label={t("boxes.open")} onOpened={(b) => select(b.id)} /> : null}
      </div>
      {boxesQ.isError ? <ErrorState title={t("boxes.list.loadFailed")} message={formatApiError(boxesQ.error)} onRetry={() => void boxesQ.refetch()} /> : null}
      {boxesQ.isPending ? <LoadingState label={t("boxes.title")} /> : null}
      {boxesQ.isSuccess ? (
        <>
          <BoxesBand boxes={boxes} />
          <div className="grid min-w-0 border-y border-line-subtle lg:grid-cols-4">
            <div className="min-w-0 border-line-subtle max-lg:border-b lg:border-r">
              <BoxList boxes={boxes} me={me} selected={selected?.id ?? null} onSelect={select} />
              <BoxQueue boxes={boxes} />
            </div>
            <div className="min-w-0 lg:col-span-3">
              {selected ? (
                <Selected box={selected} projectId={projectId} me={me} canWrite={canWrite} />
              ) : (
                <p className="px-3 py-8 text-center text-13 text-muted">{t("boxes.live.pick")}</p>
              )}
            </div>
          </div>
        </>
      ) : null}
    </PageContainer>
  );
}
