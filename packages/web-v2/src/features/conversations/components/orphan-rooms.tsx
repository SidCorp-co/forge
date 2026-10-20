"use client";

// The organization's rooms whose every project was deleted (ISS-1229 r23). Every other list here is
// a project's, so without this one such a room is found by nobody; its opener and the organization's
// admins see it, and delete it, since a room about no project takes no message.

import { useState } from "react";
import { Button, ConfirmDialog } from "@/design";
import { useDeleteConversation, useRoomsWithoutAProject } from "../hooks";
import type { RoomWithoutAProject } from "../types";

const titleOf = (room: RoomWithoutAProject) => room.title?.trim() || "Untitled conversation";

export function RoomsWithoutAProject({ orgId }: { orgId: string | null }) {
  const rooms = useRoomsWithoutAProject(orgId);
  const remove = useDeleteConversation();
  const [confirming, setConfirming] = useState<RoomWithoutAProject | null>(null);
  const list = rooms.data ?? [];
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="rooms-without-a-project" className="mt-4 border-t border-line pt-3">
      <h3 id="rooms-without-a-project" className="fg-overline px-1 text-subtle">
        Project deleted
      </h3>
      <p className="fg-caption px-1 pb-2 text-subtle">
        {list.length === 1 ? "This room's project is" : "These rooms' projects are"} gone, so nobody can
        write in {list.length === 1 ? "it" : "them"}. Delete what you no longer need.
      </p>
      <ul className="space-y-1">
        {list.map((room) => (
          <li
            key={room.id}
            data-testid="room-without-a-project"
            className="flex min-h-11 items-center gap-2 rounded-md px-2"
          >
            <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{titleOf(room)}</span>
            <Button
              variant="ghost"
              size="sm"
              icon="trash"
              aria-label={`Delete ${titleOf(room)}`}
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
            ? `“${titleOf(confirming)}” and everything said in it will be gone. Its project was deleted, so it cannot be archived and opened again.`
            : ""
        }
        confirmLabel="Delete"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => {
          if (!confirming) return;
          remove.mutate(confirming.id, { onSettled: () => setConfirming(null) });
        }}
        onClose={() => setConfirming(null)}
      />
    </section>
  );
}
