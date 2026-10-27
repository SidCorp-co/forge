"use client";

// A room whose every project was deleted, opened read-only (ISS-1229 r24): everything said in it, so
// whoever may delete it sees what it held first. It takes no message — there is no project left to
// answer under — so no composer is drawn.

import { useState } from "react";
import { Button, ConfirmDialog, EmptyState, ErrorState, PageTitle, ProjectLoader } from "@/design";
import { TabTitle } from "@/design/primitives/tab-title";
import { formatApiError } from "@/lib/api/error";
import { useConversation, useDeleteConversation } from "../hooks";
import type { RoomWithoutAProject } from "../types";
import { ConversationThread } from "./conversation-thread";
import { type OrphanFacts, orphanDeleteQuestion, orphanRoomFacts, orphanTitleOf } from "./orphan-rooms";

export function OrphanRoomView({
  room,
  facts,
  onDeleted,
}: {
  room: RoomWithoutAProject;
  /** What told this room apart in the list it was opened from, said again on its Delete. */
  facts: OrphanFacts;
  onDeleted: () => void;
}) {
  const roomQ = useConversation(room.id);
  const remove = useDeleteConversation();
  const [confirming, setConfirming] = useState(false);
  const title = orphanTitleOf(room);
  const messages = roomQ.data?.messages ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="orphan-room-view">
      <header className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <PageTitle className="fg-h3 truncate">{title}</PageTitle>
          <TabTitle subject={title} />
          <p className="fg-caption truncate text-subtle">{orphanRoomFacts(facts)}</p>
        </div>
        <Button variant="ghost" size="sm" icon="trash" aria-label={`Delete ${title}, ${orphanRoomFacts(facts)}`} onClick={() => setConfirming(true)}>
          Delete
        </Button>
      </header>
      {/* Under the header rather than where a composer stands, so no bottom bar can cover it. */}
      <p className="fg-body-sm flex-none border-b border-line bg-surface px-4 py-2 text-fg">
        Read-only: this room's project was deleted, so nobody can write in it.
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 xl:max-w-4xl">
          {roomQ.isLoading ? (
            <div className="grid place-items-center py-12">
              <ProjectLoader label="loading conversation…" />
            </div>
          ) : roomQ.isError ? (
            <ErrorState
              title="Couldn't load this conversation"
              message={formatApiError(roomQ.error)}
              error={roomQ.error} onRetry={() => void roomQ.refetch()}
            />
          ) : messages.length === 0 ? (
            <EmptyState title="Nothing was said here" message="This room was opened, and nobody wrote in it." />
          ) : (
            <ConversationThread messages={messages} windows={roomQ.data?.windows ?? []} />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Delete this conversation?"
        message={orphanDeleteQuestion(room, facts)}
        confirmLabel="Delete"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(room.id, {
            onSuccess: onDeleted,
            onSettled: () => setConfirming(false),
          })
        }
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
