"use client";

// Merged project Agents surface (Concept C, ISS-307) — Sessions (the index) +
// Chat (the single-assistant thread) under one shell. Each renders its existing
// scoped screen unchanged; this shell only arranges them.
//
// Desktop: list → detail — Sessions on the left, Chat on the right.
// Mobile:  Tabs [Sessions | Chat], one pane at a time.
// The active mobile tab is mirrored to `?tab=` (shallow replaceState, hydrated
// from the URL on mount) so deep-links work without a Suspense boundary.
import { useEffect, useState } from "react";
import { ScreenTabs, type TabItem } from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { SessionsScreen } from "@/features/sessions/components/sessions-screen";
import { ChatScreen } from "@/features/session/components/chat-screen";

type AgentsTab = "sessions" | "chat";

const TAB_VALUES = ["sessions", "chat"] as const;
const TABS: TabItem[] = [
  { value: "sessions", label: "Sessions" },
  { value: "chat", label: "Chat" },
];

export interface AgentsScreenProps {
  scope: { projectId: string };
}

export function AgentsScreen({ scope }: AgentsScreenProps) {
  const [tab, setTab] = useTabParam<AgentsTab>(TAB_VALUES, "sessions");
  // Issue deep-link (`?issue=<uuid>`) from issue-detail "Open sessions" — scopes
  // the Sessions list to one issue. Read on mount (no Suspense boundary, like
  // useTabParam); navigating here re-mounts, so a one-shot read is sufficient.
  const [issueId, setIssueId] = useState<string | undefined>(undefined);
  useEffect(() => {
    const sp = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    setIssueId(sp?.get("issue") || undefined);
  }, []);

  const sessionsScope = { projectId: scope.projectId, ...(issueId ? { issueId } : {}) };

  return (
    <div className="flex min-h-full flex-col">
      {/* Mobile: single-pane tabs. */}
      <div className="md:hidden">
        <ScreenTabs tabs={TABS} value={tab} onChange={(v) => setTab(v as AgentsTab)} />
        {tab === "sessions" ? (
          <SessionsScreen scope={sessionsScope} />
        ) : (
          <ChatScreen projectId={scope.projectId} />
        )}
      </div>

      {/* Desktop: list → detail, two panes side-by-side. */}
      <div className="hidden min-h-full md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0 border-r border-line">
          <SessionsScreen scope={sessionsScope} />
        </div>
        <div className="min-w-0">
          <ChatScreen projectId={scope.projectId} />
        </div>
      </div>
    </div>
  );
}
