"use client";

// Merged project Agents surface (Concept C, ISS-307) — Sessions (the index) +
// Chat (the single-assistant thread) under one shell. Each renders its existing
// scoped screen unchanged; this shell only arranges them.
//
// Desktop: full-width Sessions list. The Agent Chat opens as an on-demand dock
//   driven by the GLOBAL header "Ask agent" affordance (ISS-500) — the dock now
//   lives in the workspace shell so it's reachable from any screen, not just
//   here. The interactive chat session still surfaces as a row in the Sessions
//   list, so a stalled chat is visible + cancellable there.
// Mobile:  Tabs [Sessions | Chat], one pane at a time (already on-demand).
// The active mobile tab is mirrored to `?tab=` (shallow replaceState, hydrated
// from the URL on mount) so deep-links work without a Suspense boundary.
import { useEffect, useState } from "react";
import { ScreenTabs, type TabItem } from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { SessionsScreen } from "@/features/sessions/components/sessions-screen";
import { ChatScreen } from "@/features/session/components/chat-screen";

type AgentsTab = "sessions" | "chat";

const TAB_VALUES = ["sessions", "chat"] as const;
// ISS-465 — relabel the chat surface "My conversations" so it reads as the
// human-friendly interactive surface; the Sessions table remains the ops view.
const TABS: TabItem[] = [
  { value: "sessions", label: "Sessions" },
  { value: "chat", label: "My conversations" },
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

      {/* Desktop: full-width Sessions list. The chat dock is opened from the
          global header "Ask agent" action (mounted in the workspace shell). */}
      <div className="hidden min-h-full flex-col md:flex">
        <div className="min-w-0 flex-1">
          <SessionsScreen scope={sessionsScope} />
        </div>
      </div>
    </div>
  );
}
