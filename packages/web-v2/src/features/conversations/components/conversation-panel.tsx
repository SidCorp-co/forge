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
import { IconButton } from "@/design";
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

  // cm:guard the chat is REMOUNTED on a user-initiated switch and not on a draft settling into its
  // room: `ConversationChat` holds the draft's own id in state, so switching rooms without a new
  // mount would leave the room somebody just left still resolved underneath the new one. The key is
  // NOT bumped by `onConversationActive`, because that transition is one conversation becoming
  // itself and remounting it would restart the thread a person is watching arrive.
  const [mount, setMount] = useState(0);

  // cm:guard the open room is mirrored in a ref because `onGone` has to READ it without depending
  // on it: comparing inside a state updater would put a second `setState` inside an updater React
  // is free to run twice, and depending on the value would rebuild the callback the list holds on
  // every switch.
  const openIdRef = useRef<string | undefined>(undefined);

  const projectsQ = useProjects();
  const project = projectsQ.data?.find((p) => p.id === projectId);

  const show = useCallback((id: string | undefined) => {
    openIdRef.current = id;
    setOpenId(id);
    setMount((m) => m + 1);
    setView("chat");
  }, []);

  const settled = useCallback((id: string) => {
    openIdRef.current = id;
    setOpenId(id);
  }, []);

  const openRow = useCallback((row: ListedConversation) => show(row.id), [show]);
  const startNew = useCallback(() => show(undefined), [show]);

  // cm:guard a room that has just been deleted or archived stops being the open one HERE, rather
  // than being left on screen until something else happens to re-render: the panel would otherwise
  // be showing a thread its own list no longer offers, with no control that admits it is gone. A
  // room that is NOT the open one changes nothing — remounting on every archive would restart a
  // conversation somebody is reading for the sake of a row they tidied away.
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
          <h1 className="fg-h2 min-w-0 flex-1 truncate">Conversations</h1>
          <button
            type="button"
            className="fg-body-sm text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--link)]"
            onClick={() => setView("chat")}
          >
            Back to chat
          </button>
          {/* cm:guard the close control is on THIS header too and not only the chat's: the panel can
              be left showing the list, and a person who has to go back to the chat before they can
              shut the panel is one the close button has hidden from. */}
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
      onConversationActive={settled}
      onOpenHistory={() => setView("history")}
      onNew={startNew}
      // cm:guard the inline list is rendered ONLY while no room is open: once a room is, its own
      // empty state is that room being empty, and a list of other rooms under it would read as that
      // room's contents.
      emptyBody={openId === undefined ? list(true) : undefined}
      {...(onClose ? { onClose } : {})}
    />
  );
}
