"use client";

import { PeekHead, PeekPanel, type PeekState, StatusBadge } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useDraftReleaseForecast } from "@/features/forecast/hooks";
import { useRelease } from "../hooks";
import { ReleaseActions } from "./release-actions";
import { ReleaseBanner } from "./release-bits";
import { WhatChanges } from "./release-changes";
import { ReleaseFacts } from "./release-facts";

export function ReleasePeek({
  projectId,
  version,
  peek,
  onOpenFull,
}: {
  projectId: string;
  version: string;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  const t = useCopy();
  const q = useRelease(projectId, version);
  const forecastQ = useDraftReleaseForecast(projectId, q.data?.release.state === "draft");
  return (
    <PeekPanel peek={peek} listLabel={t("releases.title")} noun={t("releases.noun")} onOpenFull={onOpenFull} testId="release-peek">
      <QueryBoundary query={q} loadingLabel={t("releases.loadingOne")}>
        {(data) => {
          const r = data.release;
          return (
            <>
              <PeekHead
                noun={t("releases.noun")}
                itemKey={r.version}
                badge={<StatusBadge family="releaseState" value={r.state} />}
                title={
                  r.headline ? (
                    <span className="line-clamp-2" title={r.headline} data-testid="release-peek-headline">
                      {r.headline}
                    </span>
                  ) : (
                    t("releases.releaseVersion", { version: r.version })
                  )
                }
                action={<ReleaseActions projectId={projectId} r={r} />}
              />
              <ReleaseBanner r={r} className="px-[18px]" />
              <div className="px-[18px] pt-4">
                <WhatChanges changes={r.changes} />
              </div>
              <div className="px-[18px] pb-4 pt-4">
                <ReleaseFacts r={r} forecast={forecastQ.data} />
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </PeekPanel>
  );
}
