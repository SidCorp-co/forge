"use client";

// Merged project Agents surface (Concept C, ISS-307) — Sessions (the index) +
// Chat (the single-assistant thread) under one shell. Each renders its existing
// scoped screen unchanged; this shell only arranges them.
//
// Desktop: full-width Sessions list with the Agent Chat as an on-demand dock
//   (ISS-378 AC#7) — closed by default, opened via an explicit "Ask agent"
//   header affordance, open/closed persisted per user. The interactive chat
//   session surfaces as a row in the Sessions list, so a stalled chat is
//   visible + cancellable there rather than living only as a permanent side
//   card eating a third of the screen.
// Mobile:  Tabs [Sessions | Chat], one pane at a time (already on-demand).
// The active mobile tab is mirrored to `?tab=` (shallow replaceState, hydrated
// from the URL on mount) so deep-links work without a Suspense boundary.
import { useEffect, useState } from "react";
import { Button, ScreenTabs, SlideOver, type TabItem } from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
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

  // Per-user open/closed state for the desktop chat dock — closed by default,
  // persisted across reloads + tabs (ISS-378 AC#7).
  const [chatOpen, setChatOpen] = usePersistedState("web-v2:agents-chat-open", false);

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

      {/* Desktop: full-width Sessions list + on-demand chat dock. */}
      <div className="hidden min-h-full flex-col md:flex">
        <div className="flex items-center justify-end border-b border-line px-4 py-2">
          <Button
            variant={chatOpen ? "primary" : "secondary"}
            size="sm"
            icon="agent"
            onClick={() => setChatOpen((v) => !v)}
          >
            Ask agent
          </Button>
        </div>
        <div className="min-w-0 flex-1">
          <SessionsScreen scope={sessionsScope} />
        </div>
        <SlideOver
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          title="My conversations"
          // Responsive width: scales up on wide screens (~768px @1280, ~864px
          // @1440, capped 1024px @≥1707) instead of a fixed sliver; floor 560px
          // keeps tablet behaviour and <sm stays full-width (SlideOver). ISS-464.
          width="clamp(560px, 60vw, 1024px)"
        >
          <ChatScreen projectId={scope.projectId} />
        </SlideOver>
      </div>
    </div>
  );
}
