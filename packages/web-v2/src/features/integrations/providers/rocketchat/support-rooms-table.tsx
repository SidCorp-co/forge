// The rooms a project's bindings attach, each with its session and its health (REQ-75 r5 BC-26): a
// flat table, an unhealthy room naming each cause on a line of its own, never a bare red dot.

import type { SupportRoomHealth, SupportRoomView } from "@forge/contracts/support";
import { PageSectionTitle, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useSupportRooms } from "../../hooks";

/** A room's health: the word, and under an unhealthy one each cause as `CODE — detail`. */
export function HealthCell({ health }: { health: SupportRoomHealth }) {
  const t = useCopy();
  if (health.healthy) return <span className="fg-body-sm text-fg">{t("integrations.support.healthy")}</span>;
  return (
    <div className="flex flex-col gap-1">
      <span className="fg-body-sm font-semibold text-danger">{t("integrations.support.unhealthy")}</span>
      {health.causes.map((c) => (
        <span key={c.code} className="fg-body-sm text-muted">
          <span className="font-mono text-fg">{c.code}</span> — {c.detail}
        </span>
      ))}
    </div>
  );
}

function SessionCell({ room }: { room: SupportRoomView }) {
  const t = useCopy();
  if (!room.sessionId) return <span className="text-muted">{t("integrations.support.noSession")}</span>;
  return (
    <span>
      {room.sessionStatus ?? "—"} ·{" "}
      {room.resident ? t("integrations.support.resident") : t("integrations.support.notResident")}
    </span>
  );
}

export function SupportRoomsRows({ rooms }: { rooms: readonly SupportRoomView[] }) {
  const t = useCopy();
  if (rooms.length === 0) return <p className="fg-body-sm text-muted">{t("integrations.support.noRooms")}</p>;
  return (
    <Table aria-label={t("integrations.support.rooms")}>
      <THead>
        <TR>
          <TH>{t("integrations.support.col.group")}</TH>
          <TH>{t("integrations.support.col.kind")}</TH>
          <TH>{t("integrations.support.col.readers")}</TH>
          <TH>{t("integrations.support.col.abilities")}</TH>
          <TH>{t("integrations.support.col.session")}</TH>
          <TH>{t("integrations.support.col.health")}</TH>
        </TR>
      </THead>
      <TBody>
        {rooms.map((room) => (
          <TR key={room.id}>
            <TD>
              <div className="flex flex-col">
                <span className="fg-body-sm text-fg">{room.name ?? room.rid}</span>
                {room.name && <span className="fg-body-sm font-mono text-muted">{room.rid}</span>}
              </div>
            </TD>
            <TD className="fg-body-sm">{room.kind}</TD>
            <TD className="fg-body-sm">{room.kind === "support" ? room.readers : "—"}</TD>
            <TD className="fg-body-sm">
              {room.grants?.abilities.length ? room.grants.abilities.join(", ") : t("integrations.support.noAbilities")}
            </TD>
            <TD className="fg-body-sm">
              <SessionCell room={room} />
            </TD>
            <TD>
              <HealthCell health={room.health} />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/** The project's bound rooms, read again every 30 s. */
export function SupportRoomsTable({ projectId }: { projectId: string }) {
  const t = useCopy();
  const q = useSupportRooms(projectId);
  return (
    <section className="flex flex-col gap-2">
      <PageSectionTitle>{t("integrations.support.rooms")}</PageSectionTitle>
      {q.isLoading ? (
        <p className="fg-body-sm text-muted">{t("integrations.provider.loading")}</p>
      ) : (
        <SupportRoomsRows rooms={q.data?.rooms ?? []} />
      )}
    </section>
  );
}
