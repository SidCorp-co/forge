"use client";

import { DetailHeader, StatusBadge, useListOrigin } from "@/design";
import { useRelease } from "../hooks";
import { RELEASES_LIST, releasesListHref } from "../../../lib/routes/releases";
import { ReleaseActions } from "./release-actions";
import { ReleasePage } from "./release-page";

export function ReleaseItemScreen({ projectId, slug, version }: { projectId: string; slug: string; version: string }) {
  const q = useRelease(projectId, version);
  const back = useListOrigin(RELEASES_LIST, releasesListHref(slug));
  const r = q.data?.release;
  return (
    <div className="min-h-full bg-app" data-testid="release-item-screen">
      <DetailHeader
        back={{ href: back, label: "Releases" }}
        title={`Release ${version}`}
        badge={r ? <StatusBadge family="releaseState" value={r.state} /> : null}
        action={r ? <ReleaseActions projectId={projectId} r={r} /> : null}
      />
      <ReleasePage projectId={projectId} slug={slug} version={version} />
    </div>
  );
}
