"use client";

// Horizontal strip of open conversation panes (ISS-689). Desktop-only —
// mounted from `ConversationsScreen`'s `hidden md:flex` split region.
import { Button, EmptyState } from "@/design";
import { conversationTitle } from "@/features/session/components/conversation-list";
import type { SessionRow } from "@/features/sessions/types";
import type { AddPaneResult, PaneEntry } from "../hooks/use-conversation-panes";
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
  /** Up to a few most-recent conversations, for the empty-pane quick picks. */
  recent: SessionRow[];
  /** Conversations awaiting the owner's reply, for the "Waiting for me" pick. */
  waiting: SessionRow[];
  onOpenPane: (entry: { sessionId: string; projectId: string }) => AddPaneResult;
  onNewConversation: () => void;
}

export function ConversationPaneStrip({
  panes,
  projectById,
  awaitingBySession,
  onClosePane,
  onResizePane,
  recent,
  waiting,
  onOpenPane,
  onNewConversation,
}: ConversationPaneStripProps) {
  if (panes.length === 0) {
    return (
      <div className="grid h-full min-h-0 flex-1 place-items-center">
        <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
          <EmptyState
            title="No conversations open"
            message="Pick a conversation from the list to start chatting — open up to 4 side by side."
            mascot={false}
          />
          <div className="flex w-full max-w-[320px] flex-col gap-2">
            {waiting.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                icon="bell"
                onClick={() => onOpenPane({ sessionId: waiting[0].id, projectId: waiting[0].projectId })}
              >
                Waiting for me ({waiting.length})
              </Button>
            )}
            {recent.map((row) => (
              <Button
                key={row.id}
                variant="secondary"
                size="sm"
                onClick={() => onOpenPane({ sessionId: row.id, projectId: row.projectId })}
                className="justify-start truncate"
              >
                <span className="truncate">{conversationTitle(row)}</span>
              </Button>
            ))}
            <Button variant="primary" size="sm" icon="plus" onClick={onNewConversation}>
              New conversation
            </Button>
          </div>
        </div>
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
