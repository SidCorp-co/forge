"use client";

import { ScreenTabs, type TabItem } from "@/design";
import { SessionsScreen } from "@/features/sessions/components/sessions-screen";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { RunsPane } from "./runs-pane";

type AgentsTab = "runs" | "sessions";

const TAB_VALUES = ["runs", "sessions"] as const;
const TABS: TabItem[] = [
  { value: "runs", label: "Runs" },
  { value: "sessions", label: "Sessions" },
];

export interface AgentsScreenProps {
  scope: { projectId: string };
}

// cm:guard the Sessions pane STAYS, and replacing it with the runs view alone would be a silent substitution: a run session is one shape of work on a box, and pipeline jobs and chats — everything `agent_sessions` carries — appear in neither the ledger nor this screen's runs. Removing a surface because a better one was added next to it is the failure `CLAUDE.md` names by name (ISS-964 criteria 49, 50).
export function AgentsScreen({ scope }: AgentsScreenProps) {
  const [tab, setTab] = useTabParam<AgentsTab>(TAB_VALUES, "runs");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenTabs tabs={TABS} value={tab} onChange={(v) => setTab(v as AgentsTab)} />
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "runs" ? (
          <RunsPane scope={scope} />
        ) : (
          <SessionsScreen scope={{ projectId: scope.projectId }} />
        )}
      </div>
    </div>
  );
}
