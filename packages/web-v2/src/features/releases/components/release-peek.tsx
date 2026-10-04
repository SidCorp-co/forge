"use client";

import { ErrorState, PeekHead, PeekPanel, type PeekState, ProjectLoader, StatusBadge } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useRelease } from "../hooks";
import { ReleaseActions } from "./release-actions";
import { ReleaseBanner } from "./release-bits";
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
  const r = q.data?.release;
  return (
    <PeekPanel peek={peek} listLabel="Releases" noun="Release" onOpenFull={onOpenFull} testId="release-peek">
      {q.isLoading ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ProjectLoader label="loading release…" />
        </div>
      ) : q.isError || !r ? (
        <div className="grid min-h-[40vh] place-items-center p-4">
          <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
        </div>
      ) : (
        <>
          <PeekHead
            noun="Release"
            itemKey={r.version}
            badge={<StatusBadge family="releaseState" value={r.state} />}
            title={r.headline || `Release ${r.version}`}
            action={<ReleaseActions projectId={projectId} r={r} />}
          />
          <ReleaseBanner r={r} className="px-[18px]" />
          <div className="px-[18px] pb-4 pt-4">
            <ReleaseFacts r={r} />
          </div>
        </>
      )}
    </PeekPanel>
  );
}
