"use client";

import { Button, Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
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
  const t = useCopy();

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
      title={t("integrations.rocket.connectTitle")}
      intro={<p className="fg-body-sm text-muted">{t("integrations.rocket.connectIntro")}</p>}
      submitLabel={t("integrations.rocket.connectBot")}
      canSubmit={canSubmit}
      onSubmit={handleCreate}
    >
      <Field label={t("integrations.rocket.server")} hint={t("integrations.rocket.serverHint")} required>
        <Input placeholder="https://chat.example.com" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
      </Field>
      <Field
        label={t("integrations.rocket.token")}
        hint={t("integrations.rocket.tokenHint")}
        required
      >
        <Input
          type="password"
          autoComplete="new-password"
          placeholder={t("integrations.rocket.patPlaceholder")}
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
        />
      </Field>
      <Field label={t("integrations.rocket.userId")} hint={t("integrations.rocket.userIdHint")} required>
        <Input placeholder={t("integrations.rocket.userIdExample")} value={botUserId} onChange={(e) => setBotUserId(e.target.value)} />
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
  const t = useCopy();

  async function loadRooms() {
    if (!creds) return;
    onError(null);
    try {
      const res = await probe.mutateAsync(creds);
      setRooms(res.rooms);
      if (res.rooms.length === 0) {
        onError(t("integrations.rocket.noRooms"));
      }
    } catch (err) {
      onError(formatApiError(err));
    }
  }

  return (
    <Field
      label={t("integrations.rocket.room")}
      hint={t("integrations.rocket.roomHint")}
      required
    >
      <div className="flex items-center gap-2">
        <RoomSelect
          rooms={rooms ?? []}
          value={rid}
          onChange={onRid}
          fallback={<Input placeholder={t("integrations.rocket.ridPlaceholder")} value={rid} onChange={(e) => onRid(e.target.value)} />}
        />
        <Button variant="secondary" size="sm" loading={probe.isPending} disabled={!creds} onClick={loadRooms}>
          {t("integrations.rocket.loadRooms")}
        </Button>
      </div>
    </Field>
  );
}
