"use client";

// ISS-668 — "New conversation" flow. A project pick is REQUIRED before chat:
// an agent chat needs a codebase/runner to work against, so there is no
// project-less "general" chat (owner-locked scope). Uses `SlideOver`, which
// already ships Esc-to-close + a Tab focus trap + focus-restore (ISS-506) —
// no new a11y code needed for this new panel.
import { useEffect, useState } from "react";
import { Select, SlideOver } from "@/design";
import { useOrgScopedProjects } from "@/features/projects/hooks";
import { ChatScreen } from "@/features/session/components/chat-screen";

interface NewConversationPanelProps {
  open: boolean;
  onClose: () => void;
}

export function NewConversationPanel({ open, onClose }: NewConversationPanelProps) {
  const { projects } = useOrgScopedProjects();
  const [projectId, setProjectId] = useState<string>("");

  // Reset the picker each time the panel opens so a stale pick from a previous
  // "New conversation" doesn't silently carry over.
  useEffect(() => {
    if (open) setProjectId("");
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
        <ChatScreen projectId={projectId} initialDraft onClose={onClose} />
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
