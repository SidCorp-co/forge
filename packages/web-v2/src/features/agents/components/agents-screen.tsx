"use client";

// Merged project Agents surface (Concept C, ISS-307) — Sessions (the index) +
// Chat (the single-assistant thread) under one shell. Each renders its existing
// scoped screen unchanged; this shell only arranges them.
//
// Desktop: list → detail — Sessions on the left, Chat on the right.
// Mobile:  Tabs [Sessions | Chat], one pane at a time.
// The active mobile tab is mirrored to `?tab=` (shallow replaceState, hydrated
// from the URL on mount) so deep-links work without a Suspense boundary.
import { Tabs, type TabItem } from "@/design";
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

  return (
    <div className="flex min-h-full flex-col">
      {/* Mobile: single-pane tabs. */}
      <div className="md:hidden">
        <div className="px-4 pt-6 sm:px-8">
          <Tabs tabs={TABS} value={tab} onChange={(v) => setTab(v as AgentsTab)} />
        </div>
        {tab === "sessions" ? (
          <SessionsScreen scope={{ projectId: scope.projectId }} />
        ) : (
          <ChatScreen projectId={scope.projectId} />
        )}
      </div>

      {/* Desktop: list → detail, two panes side-by-side. */}
      <div className="hidden min-h-full md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0 border-r border-line">
          <SessionsScreen scope={{ projectId: scope.projectId }} />
        </div>
        <div className="min-w-0">
          <ChatScreen projectId={scope.projectId} />
        </div>
      </div>
    </div>
  );
}
