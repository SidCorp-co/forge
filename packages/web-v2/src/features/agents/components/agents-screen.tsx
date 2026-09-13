"use client";

import { ScreenTabs, type TabItem } from "@/design";
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
  scope: { projectId: string };
}

// cm:guard the Sessions pane STAYS, and replacing it with the runs view alone would be a silent substitution: a run session is one shape of work on a box, and pipeline jobs and chats — everything `agent_sessions` carries — appear in neither the ledger nor this screen's runs. Removing a surface because a better one was added next to it is the failure `CLAUDE.md` names by name (ISS-964 criteria 49, 50).
// cm:guard Questions is a tab of its OWN and not a band inside Runs: a question carrying `issueId: null` has no run row to hang under either — a master asks it with no worktree behind it — so folding the queue into the runs list would leave exactly that question unreachable, which is the case ISS-998 was filed on.
export function AgentsScreen({ scope }: AgentsScreenProps) {
  const [tab, setTab] = useTabParam<AgentsTab>(TAB_VALUES, "runs");
  const focusQuestionId = new URLSearchParams(useLocationSearch()).get("q");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenTabs tabs={TABS} value={tab} onChange={(v) => setTab(v as AgentsTab)} />
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "runs" && <RunsPane scope={scope} />}
        {tab === "questions" && (
          <QuestionsPane scope={scope} focusQuestionId={focusQuestionId} />
        )}
        {tab === "sessions" && <SessionsScreen scope={{ projectId: scope.projectId }} />}
      </div>
    </div>
  );
}
