"use client";

import { PeekHead, PeekPanel, type PeekState, StatusBadge } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
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
  const q = useRelease(projectId, version);
  return (
    <PeekPanel peek={peek} listLabel="Releases" noun="Release" onOpenFull={onOpenFull} testId="release-peek">
      <QueryBoundary query={q} loadingLabel="loading release…">
        {(data) => {
          const r = data.release;
          return (
            <>
              <PeekHead
                noun="Release"
                itemKey={r.version}
                badge={<StatusBadge family="releaseState" value={r.state} />}
                title={
                  r.headline ? (
                    <span className="line-clamp-2" title={r.headline} data-testid="release-peek-headline">
                      {r.headline}
                    </span>
                  ) : (
                    `Release ${r.version}`
                  )
                }
                action={<ReleaseActions projectId={projectId} r={r} />}
              />
              <ReleaseBanner r={r} className="px-[18px]" />
              <div className="px-[18px] pt-4">
                <WhatChanges changes={r.changes} />
              </div>
              <div className="px-[18px] pb-4 pt-4">
                <ReleaseFacts r={r} />
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </PeekPanel>
  );
}
