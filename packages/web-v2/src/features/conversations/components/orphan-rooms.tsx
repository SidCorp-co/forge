"use client";

// The organization's rooms whose every project was deleted (ISS-1229 r23). Every other list here is
// a project's, so without this one such a room is found by nobody; its opener and the organization's
// admins see it, read it and delete it, since a room about no project takes no message. Each row
// says which project went, when the room was opened and when it was last spoken in, so rooms with
// one title are told apart, and opens the room read-only before any delete (r24).

import { useState } from "react";
import { Button, ConfirmDialog, ErrorState } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useDeleteConversation, useRoomsWithoutAProject } from "../hooks";
import type { RoomWithoutAProject } from "../types";

export const orphanTitleOf = (room: RoomWithoutAProject) => room.title?.trim() || "Untitled conversation";

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const joined = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** What tells this room apart: the project that went, then when it was opened and its last word. */
export function orphanRoomFactLines(room: RoomWithoutAProject): [project: string, when: string] {
  const project =
    room.deletedProjectNames.length > 0
      ? `${joined(room.deletedProjectNames)} (deleted)`
      : "its project's name was not kept";
  const said = room.lastMessageAt ? `last message ${DAY.format(new Date(room.lastMessageAt))}` : "nothing said";
  return [project, `opened ${DAY.format(new Date(room.createdAt))} · ${said}`];
}

export const orphanRoomFacts = (room: RoomWithoutAProject): string => orphanRoomFactLines(room).join(" · ");

export function RoomsWithoutAProject({
  orgId,
  onOpen,
  openId,
  onDeleted,
}: {
  orgId: string | null;
  onOpen: (room: RoomWithoutAProject) => void;
  openId?: string | undefined;
  /** Told the id of a room deleted from this list, so a view still showing it can close. */
  onDeleted?: (id: string) => void;
}) {
  const rooms = useRoomsWithoutAProject(orgId);
  const remove = useDeleteConversation();
  const [confirming, setConfirming] = useState<RoomWithoutAProject | null>(null);
  const list = rooms.data ?? [];
  if (rooms.isError) {
    return (
      <div className="mt-4 border-t border-line pt-3">
        <ErrorState
          title="Couldn't load the rooms whose project was deleted"
          message={formatApiError(rooms.error)}
          onRetry={() => void rooms.refetch()}
        />
      </div>
    );
  }
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="rooms-without-a-project" className="mt-4 border-t border-line pt-3">
      <h3 id="rooms-without-a-project" className="fg-overline px-1 text-subtle">
        Project deleted
      </h3>
      <p className="fg-caption px-1 pb-2 text-subtle">
        {list.length === 1 ? "This room's project is" : "These rooms' projects are"} gone, so nobody can
        write in {list.length === 1 ? "it" : "them"}. Open one to read it; delete what you no longer need.
      </p>
      <ul className="space-y-1">
        {list.map((room) => (
          <li
            key={room.id}
            data-testid="room-without-a-project"
            className={`flex min-h-11 items-center gap-2 rounded-md px-2 ${openId === room.id ? "bg-surface" : ""}`}
          >
            <button
              type="button"
              aria-label={`Open ${orphanTitleOf(room)}, read-only: ${orphanRoomFacts(room)}`}
              aria-current={openId === room.id ? "true" : undefined}
              className="min-w-0 flex-1 py-1 text-left"
              onClick={() => onOpen(room)}
            >
              <span className="fg-body-sm block truncate text-fg">{orphanTitleOf(room)}</span>
              {orphanRoomFactLines(room).map((line) => (
                <span key={line} className="fg-caption block break-words text-subtle">
                  {line}
                </span>
              ))}
            </button>
            <Button
              variant="ghost"
              size="sm"
              icon="trash"
              aria-label={`Delete ${orphanTitleOf(room)}`}
              onClick={() => setConfirming(room)}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirming !== null}
        title="Delete this conversation?"
        message={
          confirming
            ? `“${orphanTitleOf(confirming)}” and everything said in it will be gone. Its project was deleted, so it cannot be archived and opened again.`
            : ""
        }
        confirmLabel="Delete"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => {
          if (!confirming) return;
          const id = confirming.id;
          remove.mutate(id, { onSuccess: () => onDeleted?.(id), onSettled: () => setConfirming(null) });
        }}
        onClose={() => setConfirming(null)}
      />
    </section>
  );
}
