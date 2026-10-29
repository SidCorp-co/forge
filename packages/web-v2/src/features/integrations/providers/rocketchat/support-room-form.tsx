// A support room set up in one save (REQ-75 r5 BC-25): the bot, its one group, what the room is and
// what it may do. Saving writes the binding's room and its `support` block together; core declares
// the room and warms its session from that write alone, so nothing is run on any box.

import {
  SUPPORT_ABILITIES,
  SUPPORT_ABILITY_MEANING,
  SUPPORT_ANSWERS,
  SUPPORT_READERS,
  type SupportAbility,
  type SupportRoomConfig,
} from "@forge/contracts/support";
import { type ReactNode, useMemo, useState } from "react";
import { Button, Checkbox, Field, Input, PageSectionTitle, SegmentedControl, Select, Textarea } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import {
  useBindConnection,
  useConnectionRocketchatRooms,
  useConnections,
  useIntegrationsList,
  useRocketchatRooms,
  useUpdateProviderIntegration,
} from "../../hooks";
import type { IntegrationSummary, RocketchatRoom } from "../../types";
import { RoomSelect } from "./room-select";
import {
  type SupportRoomField,
  type SupportRoomState,
  stateOf,
  supportRoomErrors,
  supportSaveConfig,
} from "./support-room-config";

/** The deploy bindings of the project a room may be granted: its active Coolify bindings. */
function useDeployTargets(projectId: string): { id: string; label: string }[] {
  const list = useIntegrationsList(projectId);
  return useMemo(
    () =>
      (list.data?.items ?? [])
        .filter((b) => b.provider === "coolify" && b.active)
        .map((b) => ({
          id: b.id,
          label: b.label || (typeof b.config.environment === "string" ? b.config.environment : b.id),
        })),
    [list.data],
  );
}

/** A new support room on a bot the person can already use. With none, the caller offers the add-a-bot form. */
export function NewSupportRoomForm({ projectId, onNewBot }: { projectId: string; onNewBot: () => void }) {
  const t = useCopy();
  const connections = useConnections();
  const bots = (connections.data?.items ?? []).filter((c) => c.provider === "rocketchat" && c.active);
  const [connectionId, setConnectionId] = useState("");
  const rooms = useConnectionRocketchatRooms(projectId, connectionId || undefined);
  const bind = useBindConnection(projectId);

  return (
    <SupportRoomFields
      projectId={projectId}
      initial={stateOf(null, "")}
      rooms={rooms.data?.rooms ?? []}
      roomsLoading={rooms.isLoading && !!connectionId}
      saving={bind.isPending}
      bot={
        <Field label={t("integrations.support.bot")} required>
          <div className="flex flex-col gap-2">
            {bots.length === 0 ? (
              <p className="fg-body-sm text-muted">{t("integrations.support.noBots")}</p>
            ) : (
              <Select
                placeholder={t("integrations.support.pickBot")}
                value={connectionId}
                onChange={setConnectionId}
                options={bots.map((b) => ({
                  value: b.id,
                  label: b.displayName ?? (typeof b.config.serverUrl === "string" ? b.config.serverUrl : b.id),
                }))}
              />
            )}
            <div>
              <Button variant="ghost" size="sm" onClick={onNewBot}>
                {t("integrations.support.newBot")}
              </Button>
            </div>
          </div>
        </Field>
      }
      canSave={!!connectionId}
      onSave={async (state) => {
        await bind.mutateAsync({
          connectionId,
          provider: "rocketchat",
          role: "service",
          binding: supportSaveConfig(state),
        });
      }}
    />
  );
}

/** The project's Rocket.Chat binding made, or kept, a support room: its one room and support block in one save. */
export function EditSupportRoomForm({ projectId, binding }: { projectId: string; binding: IntegrationSummary }) {
  const t = useCopy();
  const config = binding.bindingConfig as { rids?: string[]; support?: SupportRoomConfig; operations?: unknown };
  const rooms = useRocketchatRooms(projectId, binding.id);
  const update = useUpdateProviderIntegration(projectId);
  if (config.operations) {
    return <p className="fg-body-sm text-muted">{t("integrations.support.operationsNote")}</p>;
  }
  const carried = config.support?.limits ? { limits: config.support.limits } : undefined;
  return (
    <SupportRoomFields
      projectId={projectId}
      initial={stateOf(config.support, config.support ? (config.rids?.[0] ?? "") : "")}
      rooms={rooms.data?.rooms ?? []}
      roomsLoading={rooms.isLoading}
      saving={update.isPending}
      canSave
      saveLabel={config.support ? undefined : t("integrations.support.makeSupport")}
      carried={carried}
      onSave={async (state) => {
        await update.mutateAsync({ id: binding.id, body: { config: supportSaveConfig(state, carried) } });
      }}
    />
  );
}

function SupportRoomFields(p: {
  projectId: string;
  initial: SupportRoomState;
  rooms: RocketchatRoom[];
  roomsLoading: boolean;
  saving: boolean;
  canSave: boolean;
  saveLabel?: string | undefined;
  carried?: Pick<SupportRoomConfig, "limits"> | undefined;
  bot?: ReactNode;
  onSave: (state: SupportRoomState) => Promise<void>;
}) {
  const t = useCopy();
  const [state, setState] = useState<SupportRoomState>(p.initial);
  const [tried, setTried] = useState(false);
  const deployTargets = useDeployTargets(p.projectId);
  const errors = supportRoomErrors(state, p.carried);
  const shown = (f: SupportRoomField) => (tried ? errors[f] : undefined);
  const set = <K extends keyof SupportRoomState>(k: K, v: SupportRoomState[K]) => setState((s) => ({ ...s, [k]: v }));
  const has = (a: SupportAbility) => state.abilities.includes(a);
  const toggle = (a: SupportAbility, on: boolean) =>
    set("abilities", on ? [...state.abilities, a] : state.abilities.filter((x) => x !== a));

  async function save() {
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    await p.onSave(state).catch(() => {});
  }

  return (
    <section className="flex flex-col gap-4">
      <PageSectionTitle>{t("integrations.support.title")}</PageSectionTitle>
      {p.bot}
      <Field label={t("integrations.support.group")} required error={shown("rid")}>
        <RoomSelect
          rooms={p.rooms}
          value={state.rid}
          onChange={(rid) => set("rid", rid)}
          fallback={
            <Input
              placeholder={p.roomsLoading ? t("integrations.rocket.loadingRooms") : t("integrations.rocket.ridPlaceholder")}
              value={state.rid}
              onChange={(e) => set("rid", e.target.value)}
            />
          }
        />
      </Field>
      <Field label={t("integrations.support.product")} error={shown("product")}>
        <Input value={state.product} maxLength={600} onChange={(e) => set("product", e.target.value)} />
      </Field>
      <Field label={t("integrations.support.persona")} error={shown("persona")}>
        <Textarea rows={6} value={state.persona} maxLength={4000} onChange={(e) => set("persona", e.target.value)} />
      </Field>
      <Field label={t("integrations.support.readers")}>
        <SegmentedControl
          value={state.readers}
          onChange={(v) => set("readers", v)}
          options={SUPPORT_READERS.map((r) => ({ value: r, label: t(`integrations.support.readers.${r}`) }))}
        />
      </Field>
      <Field label={t("integrations.support.answers")}>
        <SegmentedControl
          value={state.answers}
          onChange={(v) => set("answers", v)}
          options={SUPPORT_ANSWERS.map((a) => ({ value: a, label: t(`integrations.support.answers.${a}`) }))}
        />
      </Field>
      <Field label={t("integrations.support.abilities")} error={shown("abilities")}>
        <div className="flex flex-col divide-y divide-line border-y border-line">
          {SUPPORT_ABILITIES.filter((a) => a !== "owner_mode").map((a) => (
            <div key={a} className="py-2">
              <Checkbox
                checked={has(a)}
                onChange={(on) => toggle(a, on)}
                label={
                  <span>
                    <span className="font-mono">{a}</span> — {SUPPORT_ABILITY_MEANING[a]}
                  </span>
                }
              />
            </div>
          ))}
        </div>
      </Field>
      {has("deploy") && (
        <Field label={t("integrations.support.deployTargets")} error={shown("deployTargets")}>
          {deployTargets.length === 0 ? (
            <p className="fg-body-sm text-muted">{t("integrations.support.noDeployTargets")}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {deployTargets.map((d) => (
                <Checkbox
                  key={d.id}
                  checked={state.deployTargets.includes(d.id)}
                  onChange={(on) =>
                    set("deployTargets", on ? [...state.deployTargets, d.id] : state.deployTargets.filter((x) => x !== d.id))
                  }
                  label={d.label}
                />
              ))}
            </div>
          )}
        </Field>
      )}
      {has("run_commands") && (
        <Field label={t("integrations.support.hosts")} error={shown("hosts")}>
          <Input value={state.hosts} placeholder={t("integrations.support.hostsPlaceholder")} onChange={(e) => set("hosts", e.target.value)} />
        </Field>
      )}
      {(has("build") || has("deploy") || has("run_commands")) && (
        <Field label={t("integrations.support.confirmers")} error={shown("confirmers")}>
          <Input value={state.confirmers} placeholder={t("integrations.support.confirmersPlaceholder")} onChange={(e) => set("confirmers", e.target.value)} />
        </Field>
      )}
      <div>
        <Button variant="primary" size="sm" loading={p.saving} disabled={!p.canSave} onClick={() => void save()}>
          {p.saveLabel ?? t("integrations.support.save")}
        </Button>
      </div>
    </section>
  );
}
