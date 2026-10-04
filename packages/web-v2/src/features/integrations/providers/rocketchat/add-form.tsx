"use client";

import { Button, Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useState } from "react";
import { useProbeRocketchatRooms } from "../../hooks";
import type { RocketchatRoom } from "../../types";
import { AddBindingForm, useAddBinding } from "../add-binding";
import { rocketchat } from "./index";
import { RoomSelect } from "./room-select";

export function AddRocketchatForm({ projectId }: { projectId: string }) {
  const add = useAddBinding(projectId, rocketchat.agentPathKind);
  const [serverUrl, setServerUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [botUserId, setBotUserId] = useState("");
  const [rid, setRid] = useState("");

  const credsValid =
    /^https?:\/\/.+/.test(serverUrl.trim()) && authToken.trim().length >= 8 && botUserId.trim().length > 0;
  const canSubmit = credsValid && rid.trim().length > 0 && !add.pending;
  const server = serverUrl.trim().replace(/\/+$/, "");

  const handleCreate = () =>
    add.submit({
      provider: "rocketchat",
      role: "service",
      config: { serverUrl: server, rids: [rid.trim()] },
      secrets: { authToken: authToken.trim(), userId: botUserId.trim() },
    });

  return (
    <AddBindingForm
      add={add}
      title="Connect Rocket.Chat bot"
      intro={
        <p className="fg-body-sm text-muted">
          Create a bot user on your Rocket.Chat server, add it to the project&apos;s channel, and paste its
          personal-access token below. The bot replies to @-mentions in the bound room.
        </p>
      }
      submitLabel="Connect bot"
      canSubmit={canSubmit}
      onSubmit={handleCreate}
    >
      <Field label="Server URL" hint="e.g. https://chat.example.com" required>
        <Input placeholder="https://chat.example.com" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
      </Field>
      <Field
        label="Bot auth token"
        hint="Personal-access token of the bot user (My Account → Personal Access Tokens). Stored encrypted; never shown again."
        required
      >
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="bot PAT…"
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
        />
      </Field>
      <Field label="Bot user ID" hint="Shown next to the token when it is created (X-User-Id)." required>
        <Input placeholder="e.g. hZDkzcnDqnvHDbtLo" value={botUserId} onChange={(e) => setBotUserId(e.target.value)} />
      </Field>
      <FirstRoomField
        projectId={projectId}
        creds={credsValid ? { serverUrl: server, authToken: authToken.trim(), userId: botUserId.trim() } : null}
        rid={rid}
        onRid={setRid}
        onError={add.setError}
      />
    </AddBindingForm>
  );
}

/** The first room to listen on, picked from the rooms the credential's bot has joined once loaded. */
function FirstRoomField({
  projectId,
  creds,
  rid,
  onRid,
  onError,
}: {
  projectId: string;
  creds: { serverUrl: string; authToken: string; userId: string } | null;
  rid: string;
  onRid: (rid: string) => void;
  onError: (error: string | null) => void;
}) {
  const probe = useProbeRocketchatRooms(projectId);
  const [rooms, setRooms] = useState<RocketchatRoom[] | null>(null);

  async function loadRooms() {
    if (!creds) return;
    onError(null);
    try {
      const res = await probe.mutateAsync(creds);
      setRooms(res.rooms);
      if (res.rooms.length === 0) {
        onError("The bot isn't a member of any room yet — invite it to the project's channel, then load again.");
      }
    } catch (err) {
      onError(formatApiError(err));
    }
  }

  return (
    <Field
      label="Room"
      hint="The first room this project listens on — more rooms can be added after connecting. Load rooms lists every room the bot is a member of."
      required
    >
      <div className="flex items-center gap-2">
        <RoomSelect
          rooms={rooms ?? []}
          value={rid}
          onChange={onRid}
          fallback={<Input placeholder="room id (rid)…" value={rid} onChange={(e) => onRid(e.target.value)} />}
        />
        <Button variant="secondary" size="sm" loading={probe.isPending} disabled={!creds} onClick={loadRooms}>
          Load rooms
        </Button>
      </div>
    </Field>
  );
}
