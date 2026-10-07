"use client";

import { PageTitle, Tabs, useUrlTab } from "@/design";
import { SessionsScreen } from "@/features/sessions/components/sessions-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { agentsListHref } from "@/lib/routes/agents";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useStuckRuns } from "../hooks";
import { QuestionsPane } from "./questions-pane";
import { type AgentsAccess, RunsList } from "./runs-list";

const AGENTS_TABS = ["runs", "questions", "sessions"] as const;
type AgentsTab = (typeof AGENTS_TABS)[number];

export function AgentsScreen({ access }: { access: AgentsAccess }) {
  const t = useCopy();
  const TABS = [
    { value: "runs", label: t("agents.tab.runs") },
    { value: "questions", label: t("agents.tab.questions") },
    { value: "sessions", label: t("agents.tab.sessions") },
  ];
  const [urlTab, setTab] = useUrlTab(AGENTS_TABS);
  const params = new URLSearchParams(useLocationSearch());
  const focusQuestionId = params.get("q");
  // `?issue=` names whose sessions to list, so a link carrying only it lands on that tab.
  const issueId = params.get("issue");
  const tab: AgentsTab = issueId && !params.has("tab") ? "sessions" : urlTab;

  return (
    <div className="grid min-h-full content-start bg-app" data-testid="agents-screen">
      <PageTitle hint={t("agents.hint")}>{t("agents.title")}</PageTitle>
      <div className="border-b border-line-subtle px-5 max-md:px-2" data-testid="agents-tabs">
        <Tabs tabs={TABS} value={tab} onChange={(t) => setTab(t as AgentsTab)} />
      </div>
      {tab === "runs" ? <RunsList access={access} /> : null}
      {tab === "questions" ? <QuestionsPane scope={access} focusQuestionId={focusQuestionId} /> : null}
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
