"use client";

// The whole of what "Ask agent" opens (ISS-1028) — the docked column on desktop
// and the overlay below md both mount this, so there is one answer to what the
// panel does rather than two that drift.
//
// It owns two things the chat and the list both need and neither may hold: which
// room is open, and which of the two views is showing. ISS-732's rule survives
// unchanged — a fresh mount opens NO room, so closing the panel and reopening it
// lands on a new draft and nothing is resumed behind anybody's back. What was
// missing, and is here, is the way back: the list is in the draft's own body the
// moment it opens, and a labelled control in the chat header reaches it from any
// room.

import { useCallback, useRef, useState } from "react";
import {
  IconButton,
  PageTitle,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import type { ListedConversation } from "../hooks";
import { ConversationChat } from "./conversation-chat";
import { ConversationList } from "./conversation-list";

export function ConversationPanel({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose?: () => void;
}) {
  const [view, setView] = useState<"chat" | "history">("chat");
  const [openId, setOpenId] = useState<string | undefined>(undefined);

  const [mount, setMount] = useState(0);

  const openIdRef = useRef<string | undefined>(undefined);
  const generation = useRef(0);

  const projectsQ = useProjects();
  const project = projectsQ.data?.find((p) => p.id === projectId);

  const show = useCallback((id: string | undefined) => {
    openIdRef.current = id;
    generation.current += 1;
    setMount(generation.current);
    setView("chat");
    setOpenId(id);
  }, []);

  const settledIn = useCallback(
    (forGeneration: number) => (id: string) => {
      if (forGeneration !== generation.current) return;
      openIdRef.current = id;
      setOpenId(id);
    },
    [],
  );

  const openRow = useCallback((row: ListedConversation) => show(row.id), [show]);
  const startNew = useCallback(() => show(undefined), [show]);

  const onGone = useCallback(
    (id: string) => {
      if (openIdRef.current !== id) return;
      show(undefined);
    },
    [show],
  );

  const list = (inline: boolean) => (
    <ConversationList
      projectId={projectId}
      projectName={project?.name ?? "This project"}
      projectSlug={project?.slug ?? projectId}
      activeConversationId={openId}
      onOpen={openRow}
      onNew={startNew}
      onGone={onGone}
      inline={inline}
    />
  );

  if (view === "history") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex flex-none items-center gap-3 border-b border-line bg-app/95 px-4 py-3">
          <PageTitle className="fg-h2 min-w-0 flex-1 truncate">Conversations</PageTitle>
          <button
            type="button"
            className="fg-body-sm text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--link)]"
            onClick={() => setView("chat")}
          >
            Back to chat
          </button>
          {onClose && (
            <IconButton icon="x" size="sm" aria-label="Close conversation" onClick={onClose} />
          )}
        </header>
        <div className="min-h-0 flex-1">{list(false)}</div>
      </div>
    );
  }

  return (
    <ConversationChat
      key={mount}
      projectId={projectId}
      conversationId={openId}
      onConversationActive={settledIn(mount)}
      onOpenHistory={() => setView("history")}
      onNew={startNew}
      emptyBody={openId === undefined ? list(true) : undefined}
      {...(onClose ? { onClose } : {})}
    />
  );
}
