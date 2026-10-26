"use client";

import { PageContainer, PageTitle, ScreenTabs, type TabItem } from "@/design";
import { SessionsScreen } from "@/features/sessions/components/sessions-screen";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { QuestionsPane } from "./questions-pane";
import { RunsPane } from "./runs-pane";

type AgentsTab = "runs" | "questions" | "sessions";

const TAB_VALUES = ["runs", "questions", "sessions"] as const;
const TABS: TabItem[] = [
  { value: "runs", label: "Runs" },
  { value: "questions", label: "Questions" },
  { value: "sessions", label: "Sessions" },
];

export interface AgentsScreenProps {
  scope: { projectId: string; slug: string };
}

export function AgentsScreen({ scope }: AgentsScreenProps) {
  const [tab, setTab] = useTabParam<AgentsTab>(TAB_VALUES, "runs");
  const focusQuestionId = new URLSearchParams(useLocationSearch()).get("q");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The page's one h1 and its tab, whichever pane is open (ISS-1229 r47, judge-137). */}
      <ScreenTabs
        tabs={TABS}
        value={tab}
        onChange={(v) => setTab(v as AgentsTab)}
        header={
          <header className="mb-4">
            <PageTitle className="fg-h2">Agents</PageTitle>
          </header>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {/* The panes sit in the column the tab strip draws, so their rows end where its divider ends. */}
        {tab !== "sessions" && (
          <PageContainer className="py-0 sm:py-0" data-testid="agents-column">
            {tab === "runs" && <RunsPane scope={scope} />}
            {tab === "questions" && <QuestionsPane scope={scope} focusQuestionId={focusQuestionId} />}
          </PageContainer>
        )}
        {tab === "sessions" && <SessionsScreen scope={{ projectId: scope.projectId }} />}
      </div>
    </div>
  );
}
