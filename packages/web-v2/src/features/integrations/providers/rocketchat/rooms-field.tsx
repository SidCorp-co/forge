"use client";

import { Button, Field, Input } from "@/design";
import { useMemo, useState } from "react";
import { useRocketchatRooms } from "../../hooks";
import { RoomSelect } from "./room-select";

/** The rooms a binding listens on: never fewer than one, picked from the rooms the bot has joined. */
export function RoomsField({
  projectId,
  bindingId,
  savedRids,
  saving,
  onSave,
}: {
  projectId: string;
  bindingId: string;
  savedRids: string[];
  saving: boolean;
  onSave: (next: string[]) => Promise<boolean>;
}) {
  const roomsQ = useRocketchatRooms(projectId, bindingId);
  const rooms = useMemo(() => roomsQ.data?.rooms ?? [], [roomsQ.data]);
  const [newRid, setNewRid] = useState("");

  async function save(next: string[]) {
    if (await onSave(next)) setNewRid("");
  }

  return (
    <Field
      label="Rooms"
      hint="The rooms this project listens on. The picker lists every room the bot is a member of — invite the bot to a room to make it appear here."
    >
      <div className="flex flex-col gap-2">
        {savedRids.map((r) => (
          <div key={r} className="flex items-center gap-2">
            <span className="fg-body-sm flex-1 truncate">
              {rooms.find((room) => room.rid === r)?.name ?? "unknown room"}{" "}
              <span className="text-muted font-mono">{r}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon="trash"
              loading={saving}
              disabled={savedRids.length === 1}
              onClick={() => save(savedRids.filter((x) => x !== r))}
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <RoomSelect
            rooms={rooms.filter((r) => !savedRids.includes(r.rid))}
            value={newRid}
            onChange={setNewRid}
            fallback={
              <Input
                placeholder={roomsQ.isLoading ? "loading rooms…" : "room id (rid)…"}
                value={newRid}
                onChange={(e) => setNewRid(e.target.value)}
              />
            }
          />
          <Button
            variant="secondary"
            size="sm"
            loading={saving}
            disabled={!newRid.trim() || savedRids.includes(newRid.trim())}
            onClick={() => save([...savedRids, newRid.trim()])}
          >
            Add room
          </Button>
        </div>
      </div>
    </Field>
  );
}
