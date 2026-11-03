// The workspace home for a person (ISS-919, FB-483): across every project they read, what waits on
// them, what is moving for what they gave, and what is live, three flat tables in that order. The
// org figures the page showed before sit under the Figures tab, so nothing is lost.

import { PageContainer, PageTitle, Tabs, useUrlChoice } from "@/design";
import { useActiveOrg } from "@/features/orgs";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useHome } from "../hooks";
import { LiveReleases } from "./live-releases";
import { MovingWork } from "./moving-work";
import { OverviewFigures } from "./overview-screen";
import { WaitingOnYou } from "./waiting-on-you";

const HOME_TABS = ["home", "figures"] as const;
type HomeTab = (typeof HOME_TABS)[number];

export function HomeScreen() {
  const t = useCopy();
  const [tab, setTab] = useUrlChoice<HomeTab>("tab", HOME_TABS, "home");
  return (
    <PageContainer className="flex flex-col gap-6">
      <PageTitle>{t("overview.home.title")}</PageTitle>
      <Tabs
        tabs={[
          { value: "home", label: t("overview.home.tab.home") },
          { value: "figures", label: t("overview.home.tab.figures") },
        ]}
        value={tab}
        onChange={(v) => setTab(v as HomeTab)}
      />
      {tab === "home" ? <HomeTables /> : <OverviewFigures />}
    </PageContainer>
  );
}

function HomeTables() {
  const t = useCopy();
  const { activeOrgId } = useActiveOrg();
  const home = useHome(activeOrgId);
  return (
    <div className="flex flex-col gap-8">
      <WaitingOnYou owed={home.data?.waiting ?? []} />
      <QueryBoundary query={home} loadingLabel={t("overview.home.loading")} height="inline">
        {(data) => (
          <>
            <MovingWork items={data.moving} total={data.movingTotal} truncated={data.movingTruncated} />
            <LiveReleases live={data.live} />
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
