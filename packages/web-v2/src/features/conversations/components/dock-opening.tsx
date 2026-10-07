"use client";

// What Ask Agent opens on when nothing is picked, and the one-click way back to a conversation in
// which the agent asked the person something (ISS-277, FB-88). Both read the project's rooms through
// the list's own cache, and the thread status core reads (`waiting_on_you`).

import { useEffect } from "react";
import { ErrorState, StatusBadge } from "@/design";
import { type ChatTarget, openingTarget, waitingRoom } from "@/features/chat-dock/dock-target";
import { formatApiError } from "@/lib/api/error";
import { useProjectConversations } from "../hooks";
import { conversationTitle } from "../types";

/** Reads the project's rooms and hands the dock the one to open; a read that fails says so, and opens nothing in its place. */
export function DockOpening({
  projectId,
  pageKey,
  onResolved,
}: {
  projectId: string;
  pageKey: string | null;
  onResolved: (target: ChatTarget) => void;
}) {
  const q = useProjectConversations(projectId);
  const rows = q.data;
  useEffect(() => {
    if (rows) onResolved(openingTarget(rows, { projectId, pageKey }));
  }, [rows, projectId, pageKey, onResolved]);
  if (q.isError) {
    return (
      <ErrorState
        title="Conversations could not be read"
        message={formatApiError(q.error)}
        onRetry={() => void q.refetch()}
      />
    );
  }
  return <p className="fg-body-sm p-4 text-muted">Opening your latest conversation…</p>;
}

/** A strip naming the conversation waiting on the person, when it is not the one open. */
export function WaitingOffer({
  projectId,
  openId,
  onOpen,
}: {
  projectId: string;
  openId: string | null;
  onOpen: (target: ChatTarget) => void;
}) {
  const q = useProjectConversations(projectId);
  const room = q.data ? waitingRoom(q.data, { projectId, openId }) : null;
  if (!room) return null;
  const title = conversationTitle(room);
  return (
    <button
      type="button"
      data-testid="waiting-offer"
      aria-label={`Open ${title}, waiting on you`}
      onClick={() => onOpen({ kind: "room", projectId, conversationId: room.id })}
      className="flex w-full flex-none items-center gap-2 border-b border-line bg-sunken px-3 py-1.5 text-left hover:bg-hover"
    >
      <StatusBadge family="thread" value="waiting_on_you" />
      <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{title}</span>
      <span aria-hidden className="fg-caption flex-none font-semibold text-link">
        Open
      </span>
    </button>
  );
}
