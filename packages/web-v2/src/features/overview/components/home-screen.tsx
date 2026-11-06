// The workspace home for a person (ISS-919, FB-483; ISS-1069): what they asked for that is not live
// yet, across every project they read. It is the one thing Activity does not show. What waits on them,
// what runs and what shipped are Activity's, the one cross-project screen, so the home draws none of
// them, and a link kept to its old Figures tab lands on Activity.

import { useEffect } from "react";
import { PageContainer, PageTitle } from "@/design";
import { useActiveOrg } from "@/features/orgs";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRouter } from "@/lib/navigation/router";
import { useHome } from "../hooks";
import { MovingWork } from "./moving-work";

/** The tab the home had before (ISS-919): its figures went with Ops, and a kept link reads Activity. */
function useFiguresMoved(): boolean {
  const router = useRouter();
  const moved = new URLSearchParams(window.location.search).get("tab") === "figures";
  useEffect(() => {
    if (moved) router.replace("/activity");
  }, [moved, router]);
  return moved;
}

export function HomeScreen() {
  const t = useCopy();
  const { activeOrgId } = useActiveOrg();
  const moved = useFiguresMoved();
  const home = useHome(moved ? null : activeOrgId);
  if (moved) return null;
  return (
    <PageContainer className="flex flex-col gap-6">
      <PageTitle>{t("overview.home.title")}</PageTitle>
      <QueryBoundary query={home} loadingLabel={t("overview.home.loading")} height="inline">
        {(data) => <MovingWork items={data.moving} total={data.movingTotal} truncated={data.movingTruncated} />}
      </QueryBoundary>
    </PageContainer>
  );
}
