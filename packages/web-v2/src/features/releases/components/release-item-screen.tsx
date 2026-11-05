
import { DetailHeader, DetailMobileTitle, StatusBadge, useListOrigin } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRelease } from "../hooks";
import { RELEASES_LIST, releasesListHref } from "@/lib/routes/releases";
import { ReleaseActions } from "./release-actions";
import { ReleaseTitle } from "./release-bits";
import { ReleasePage } from "./release-page";

export function ReleaseItemScreen({ projectId, slug, version }: { projectId: string; slug: string; version: string }) {
  const t = useCopy();
  const q = useRelease(projectId, version);
  const back = useListOrigin(RELEASES_LIST, releasesListHref(slug));
  const r = q.data?.release;
  return (
    <div className="min-h-full bg-app" data-testid="release-item-screen">
      <DetailHeader
        back={{ href: back, label: t("releases.title") }}
        title={r ? <ReleaseTitle r={r} /> : t("releases.releaseVersion", { version })}
        badge={r ? <StatusBadge family="releaseState" value={r.state} /> : null}
        action={r ? <ReleaseActions projectId={projectId} r={r} /> : null}
      />
      {/* below the wide column the bar's acts leave the title no room: the page heads itself */}
      {r ? <DetailMobileTitle title={<ReleaseTitle r={r} />} badge={<StatusBadge family="releaseState" value={r.state} />} /> : null}
      <ReleasePage projectId={projectId} slug={slug} version={version} />
    </div>
  );
}
