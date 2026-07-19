"use client";

// Horizontal strip of open conversation panes (ISS-689). Desktop-only —
// mounted from `ConversationsScreen`'s `hidden md:flex` split region.
import { EmptyState } from "@/design";
import type { PaneEntry } from "../hooks/use-conversation-panes";
import { ConversationPane } from "./conversation-pane";

interface ProjectInfo {
  name: string;
  slug: string;
}

interface ConversationPaneStripProps {
  panes: PaneEntry[];
  projectById: Map<string, ProjectInfo>;
  awaitingBySession: Set<string>;
  onClosePane: (sessionId: string) => void;
  onResizePane: (sessionId: string, width: number) => void;
}

export function ConversationPaneStrip({
  panes,
  projectById,
  awaitingBySession,
  onClosePane,
  onResizePane,
}: ConversationPaneStripProps) {
  if (panes.length === 0) {
    return (
      <div className="grid h-full min-h-0 flex-1 place-items-center">
        <EmptyState
          title="No conversations open"
          message="Pick a conversation from the list to start chatting — open up to 4 side by side."
          mascot={false}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 gap-3 overflow-x-auto">
      {panes.map((entry) => {
        const project = projectById.get(entry.projectId);
        return (
          <ConversationPane
            key={entry.sessionId}
            entry={entry}
            projectName={project?.name ?? entry.projectId.slice(0, 8)}
            projectSlug={project?.slug}
            awaiting={awaitingBySession.has(entry.sessionId)}
            onClose={() => onClosePane(entry.sessionId)}
            onResize={(width) => onResizePane(entry.sessionId, width)}
          />
        );
      })}
    </div>
  );
}
