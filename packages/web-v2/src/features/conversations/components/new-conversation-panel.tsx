"use client";

// ISS-668 — "New conversation" flow. A project pick is REQUIRED before chat:
// an agent chat needs a codebase/runner to work against, so there is no
// project-less "general" chat (owner-locked scope). Uses `SlideOver`, which
// already ships Esc-to-close + a Tab focus trap + focus-restore (ISS-506) —
// no new a11y code needed for this new panel.
import { useEffect, useState } from "react";
import { Button, Select, SlideOver } from "@/design";
import { useOrgScopedProjects } from "@/features/projects/hooks";
import { ChatScreen } from "@/features/session/components/chat-screen";
import type { AddPaneResult } from "../hooks/use-conversation-panes";

interface NewConversationPanelProps {
  open: boolean;
  onClose: () => void;
  /** Desktop-only (ISS-689): opens the just-started chat as a pane instead of
   *  only a SlideOver. Omitted on mobile — no pane strip to add it to. */
  onOpenPane?: (entry: { sessionId: string; projectId: string }) => AddPaneResult;
}

export function NewConversationPanel({ open, onClose, onOpenPane }: NewConversationPanelProps) {
  const { projects } = useOrgScopedProjects();
  const [projectId, setProjectId] = useState<string>("");
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();

  // Reset the picker each time the panel opens so a stale pick from a previous
  // "New conversation" doesn't silently carry over.
  useEffect(() => {
    if (open) {
      setProjectId("");
      setActiveSessionId(undefined);
    }
  }, [open]);

  const options = projects.map((p) => ({ value: p.id, label: p.name }));

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title="New conversation"
      width="clamp(560px, 55vw, 920px)"
      fitBody
    >
      {projectId ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            <ChatScreen
              projectId={projectId}
              initialDraft
              onClose={onClose}
              onSessionActive={setActiveSessionId}
            />
          </div>
          {onOpenPane && activeSessionId && (
            // Desktop-only affordance (ISS-689) — the pane strip this opens
            // into only exists at md+; mobile keeps the plain SlideOver flow.
            <div className="hidden flex-none justify-end border-t border-line px-4 py-2 md:flex">
              <Button
                variant="secondary"
                size="sm"
                icon="board"
                onClick={() => {
                  onOpenPane({ sessionId: activeSessionId, projectId });
                  onClose();
                }}
              >
                Open as pane
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-full flex-col gap-3 p-5">
          <label htmlFor="new-conversation-project" className="fg-body-sm text-muted">
            Pick a project to start chatting with its agent.
          </label>
          <Select
            id="new-conversation-project"
            options={options}
            value={projectId}
            onChange={setProjectId}
            placeholder="Select a project…"
          />
        </div>
      )}
    </SlideOver>
  );
}
