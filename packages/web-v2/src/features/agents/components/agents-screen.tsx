
import { useEffect } from "react";
import { PageTitle, Tabs, useUrlTab } from "@/design";
import { SessionsScreen } from "@/features/sessions";
import { useCopy } from "@/lib/i18n/interface-language";
import { agentsListHref } from "@/lib/routes/agents";
import { capabilitiesHref } from "@/lib/routes/modules";
import { useRouter } from "@/lib/navigation/router";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useStuckRuns } from "../hooks";
import { type AgentsAccess, RunsList } from "./runs-list";

const AGENTS_TABS = ["runs", "sessions"] as const;
type AgentsTab = (typeof AGENTS_TABS)[number];

export function AgentsScreen({ access }: { access: AgentsAccess }) {
  const t = useCopy();
  const TABS = [
    { value: "runs", label: t("agents.tab.runs") },
    { value: "sessions", label: t("agents.tab.sessions") },
  ];
  const [urlTab, setTab] = useUrlTab(AGENTS_TABS);
  const params = new URLSearchParams(useLocationSearch());
  // `?issue=` names whose sessions to list, so a link carrying only it lands on that tab.
  const issueId = params.get("issue");
  const tab: AgentsTab = issueId && !params.has("tab") ? "sessions" : urlTab;
  // ISS-1256: the capabilities page is the module map's Capabilities branch; a link kept from the old tab lands there
  const moved = params.get("tab") === "capabilities";
  const router = useRouter();
  useEffect(() => {
    if (moved) router.replace(capabilitiesHref(access.slug));
  }, [moved, router, access.slug]);
  if (moved) return null;

  return (
    <div className="grid min-h-full content-start bg-app" data-testid="agents-screen">
      <PageTitle>{t("agents.title")}</PageTitle>
      <div className="border-b border-line-subtle px-5 max-md:px-2" data-testid="agents-tabs">
        <Tabs tabs={TABS} value={tab} onChange={(t) => setTab(t as AgentsTab)} />
      </div>
      {tab === "runs" ? <RunsList access={access} /> : null}
      {tab === "sessions" ? <SessionsTab projectId={access.projectId} slug={access.slug} issueId={issueId} /> : null}
    </div>
  );
}

/** The sessions tab reads each row against the runs core holds stuck, which this feature owns. */
function SessionsTab({ projectId, slug, issueId }: { projectId: string; slug: string; issueId: string | null }) {
  return (
    <SessionsScreen
      key={issueId ?? "all"}
      projectId={projectId}
      issueFilter={issueId ? { issueId, clearHref: `${agentsListHref(slug)}?tab=sessions` } : null}
      stuck={useStuckRuns(projectId)}
    />
  );
}
