"use client";

// The organization's rooms whose every project was deleted (ISS-1229 r23). Every other list here is
// a project's, so without this one such a room is found by nobody; its opener and the organization's
// admins see it, read it and delete it, since a room about no project takes no message; a one-to-one
// room only its people (r25). Each row says which project went, when the room was opened and when it
// was last spoken in, finer where two still read alike, and opens the room read-only (r24, r25).

import { useState } from "react";
import { Button, ConfirmDialog, ErrorState } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useDeleteConversation, useRoomsWithoutAProject } from "../hooks";
import type { RoomWithoutAProject } from "../types";

export const orphanTitleOf = (room: RoomWithoutAProject) => room.title?.trim() || "Untitled conversation";

// In the reader's own time zone, as every time the web shows is (ISS-1229 r25).
const dayOf = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(iso));
const minuteOf = (iso: string) =>
  `${dayOf(iso)}, ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso))}`;
const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

const joined = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** The two lines that tell a room apart: the project that went, then when it was opened and its last word. */
export type OrphanFacts = [project: string, when: string];

function factLines(room: RoomWithoutAProject, at: (iso: string) => string): OrphanFacts {
  const project =
    room.deletedProjectNames.length > 0
      ? `${joined(room.deletedProjectNames)} (deleted)`
      : "its project's name was not kept";
  const said = room.lastMessageAt ? `last message ${at(room.lastMessageAt)}` : "nothing said";
  return [project, `opened ${at(room.createdAt)} · ${said}`];
}

/**
 * Each room's facts, made finer only for the rows that still read like another one (ISS-1229 r25):
 * the day, then the minute, then its place in the order opened — the way two people in a room are
 * told apart. Two untitled rooms opened two minutes apart read alike no longer.
 */
export function orphanRoomFactsApart(rooms: readonly RoomWithoutAProject[]): Map<string, OrphanFacts> {
  const read = (room: RoomWithoutAProject, lines: OrphanFacts) => `${orphanTitleOf(room)}|${lines.join("|")}`;
  const out = new Map<string, OrphanFacts>();
  for (const room of rooms) {
    const coarse = factLines(room, dayOf);
    const alike = rooms.filter((o) => read(o, factLines(o, dayOf)) === read(room, coarse));
    if (alike.length < 2) {
      out.set(room.id, coarse);
      continue;
    }
    const fine = factLines(room, minuteOf);
    const sameMinute = alike
      .filter((o) => read(o, factLines(o, minuteOf)) === read(room, fine))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (sameMinute.length < 2) {
      out.set(room.id, fine);
      continue;
    }
    const place = sameMinute.findIndex((o) => o.id === room.id);
    out.set(room.id, [fine[0], `${fine[1]} · the ${ORDINALS[place] ?? `number ${place + 1}`} opened that minute`]);
  }
  return out;
}

export const orphanRoomFacts = (facts: OrphanFacts): string => facts.join(" · ");

/** The question before a room is deleted, naming what tells it apart, so the right one goes. */
export const orphanDeleteQuestion = (room: RoomWithoutAProject, facts: OrphanFacts): string =>
  `“${orphanTitleOf(room)}” (${orphanRoomFacts(facts)}) and everything said in it will be gone. Its project was deleted, so it cannot be archived and opened again.`;

export function RoomsWithoutAProject({
  orgId,
  onOpen,
  openId,
  onDeleted,
}: {
  orgId: string | null;
  onOpen: (room: RoomWithoutAProject, facts: OrphanFacts) => void;
  openId?: string | undefined;
  /** Told the id of a room deleted from this list, so a view still showing it can close. */
  onDeleted?: (id: string) => void;
}) {
  const rooms = useRoomsWithoutAProject(orgId);
  const remove = useDeleteConversation();
  const [confirming, setConfirming] = useState<RoomWithoutAProject | null>(null);
  const list = rooms.data ?? [];
  const apart = orphanRoomFactsApart(list);
  const factsOf = (room: RoomWithoutAProject): OrphanFacts => apart.get(room.id) ?? factLines(room, minuteOf);
  if (rooms.isError) {
    return (
      <div className="mt-4 border-t border-line pt-3">
        <ErrorState
          title="Couldn't load the rooms whose project was deleted"
          message={formatApiError(rooms.error)}
          error={rooms.error} onRetry={() => void rooms.refetch()}
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
        {list.map((room) => {
          const facts = factsOf(room);
          return (
          <li
            key={room.id}
            data-testid="room-without-a-project"
            className={`flex min-h-11 items-center gap-2 rounded-md px-2 ${openId === room.id ? "bg-surface" : ""}`}
          >
            <button
              type="button"
              aria-label={`Open ${orphanTitleOf(room)}, read-only: ${orphanRoomFacts(facts)}`}
              aria-current={openId === room.id ? "true" : undefined}
              className="min-w-0 flex-1 py-1 text-left"
              onClick={() => onOpen(room, facts)}
            >
              <span className="fg-body-sm block truncate text-fg">{orphanTitleOf(room)}</span>
              {facts.map((line) => (
                <span key={line} className="fg-caption block break-words text-subtle">
                  {line}
                </span>
              ))}
            </button>
            <Button
              variant="ghost"
              size="sm"
              icon="trash"
              aria-label={`Delete ${orphanTitleOf(room)}, ${orphanRoomFacts(facts)}`}
              onClick={() => setConfirming(room)}
            >
              Delete
            </Button>
          </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={confirming !== null}
        title="Delete this conversation?"
        message={
          confirming ? orphanDeleteQuestion(confirming, factsOf(confirming)) : ""
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
