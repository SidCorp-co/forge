"use client";

import { PageTitle, Tabs, useUrlTab } from "@/design";
import { SessionsScreen } from "@/features/sessions/components/sessions-screen";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { QuestionsPane } from "./questions-pane";
import { type AgentsAccess, RunsList } from "./runs-list";

const AGENTS_TABS = ["runs", "questions", "sessions"] as const;
type AgentsTab = (typeof AGENTS_TABS)[number];

const TABS = [
  { value: "runs", label: "Runs" },
  { value: "questions", label: "Questions" },
  { value: "sessions", label: "Sessions" },
];

export function AgentsScreen({ access }: { access: AgentsAccess }) {
  const [tab, setTab] = useUrlTab(AGENTS_TABS);
  const focusQuestionId = new URLSearchParams(useLocationSearch()).get("q");

  return (
    <div className="grid min-h-full content-start bg-app" data-testid="agents-screen">
      <PageTitle hint="Every run core knows of, the project master beside them, and the questions agents asked.">Agents / Runs</PageTitle>
      <div className="border-b border-line-subtle px-5 max-md:px-2" data-testid="agents-tabs">
        <Tabs tabs={TABS} value={tab} onChange={(t) => setTab(t as AgentsTab)} />
      </div>
      {tab === "runs" ? <RunsList access={access} /> : null}
      {tab === "questions" ? <QuestionsPane scope={access} focusQuestionId={focusQuestionId} /> : null}
      {tab === "sessions" ? <SessionsScreen scope={{ projectId: access.projectId }} /> : null}
    </div>
  );
}
