
import { ProjectMark, StatusBadge, Tooltip } from "@/design";
import { readingOf } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatRelativeTime } from "@/lib/utils/format";
import { type Bus, callSiteAt, type LinkRecord, stateMeaning, shortSha, slugsOf, projectMarkProps } from "../bus";
import { useLink } from "../hooks";
import { Caption, Group, Head } from "./bus-detail-kit";
import { Loading, UnreadNotice } from "./notices";

export function LinkDetail({ bus, id }: { bus: Bus; id: string }) {
  const t = useCopy();
  const l = bus.links.find((x) => x.id === id);
  const reading = readingOf(useLink(l?.consumer, l?.id));
  if (!l) return <Caption>{t("ecosystem.link.gone")}</Caption>;
  const consumer = slugsOf(bus).get(l.consumer) ?? t("ecosystem.bus.aMember");
  return (
    <>
      <Head>
        <ProjectMark {...projectMarkProps(consumer)} size={22} />
        <h2 className="text-15 font-semibold">
          {consumer} <span className="text-subtle">→</span> <span className="font-mono">{l.contract.slug}</span>
        </h2>
        <Tooltip label={stateMeaning(l.state, t)}>
          <StatusBadge family="link" value={l.state} />
        </Tooltip>
        <Tooltip label={t("ecosystem.link.updated", { when: new Date(l.updatedAt).toLocaleString() })}>
          <span className="fg-caption">
            {l.module} · {t("ecosystem.bus.onVersion", { version: l.pinnedVersion })} · {formatRelativeTime(l.updatedAt)}
          </span>
        </Tooltip>
      </Head>
      {reading.kind === "loading" ? (
        <div className="col-span-full px-4">
          <Loading what={t("ecosystem.link.guideWhat", { consumer })} />
        </div>
      ) : null}
      {reading.kind === "unread" ? (
        <div className="col-span-full px-4 pb-3">
          <UnreadNotice what={t("ecosystem.link.guideWhat", { consumer })} refusals={reading.refusals} />
        </div>
      ) : null}
      {reading.kind === "read" ? <Guide record={reading.value} /> : null}
    </>
  );
}

function UsesGroup({ d }: { d: LinkRecord["document"] }) {
  const t = useCopy();
  return (
    <Group title={t("ecosystem.link.uses")}>
      {d.fieldsUsed.length === 0 ? (
        <Caption>{t("ecosystem.link.noFields")}</Caption>
      ) : (
        <div className="flex flex-wrap gap-1">
          {d.fieldsUsed.map((f) => (
            <span key={f} className="rounded-pill bg-sunken px-2 font-mono text-11">
              {f}
            </span>
          ))}
        </div>
      )}
      {d.outsideContract.length > 0 ? (
        <>
          <h4 className="pt-2 text-11 font-semibold uppercase tracking-wider" style={{ color: "var(--amberw-600)" }}>
            {t("ecosystem.link.outside")}
          </h4>
          {d.outsideContract.map((o) => (
            <span key={o} className="font-mono text-11-5" style={{ color: "var(--amberw-600)" }}>
              {o}
            </span>
          ))}
        </>
      ) : null}
    </Group>
  );
}

function Guide({ record }: { record: LinkRecord }) {
  const t = useCopy();
  const d = record.document;
  return (
    <>
      <Group title={t("ecosystem.link.callSites")} aside={d.callSites.length || undefined}>
        {d.callSites.length === 0 ? (
          <Caption>{t("ecosystem.link.noCallSites")}</Caption>
        ) : (
          d.callSites.map((s) => (
            <div key={`${callSiteAt(s)}:${s.operation}`} className="flex min-w-0 justify-between gap-2 font-mono text-11-5">
              <span className="truncate" style={{ color: "var(--cobalt-700)" }}>
                {callSiteAt(s)}
              </span>
              <span className="truncate">{s.operation}</span>
            </div>
          ))
        )}
      </Group>
      <UsesGroup d={d} />
      <Group title={t("ecosystem.link.notes")}>
        {d.notes.length === 0 ? (
          <Caption>{t("ecosystem.link.notesNone")}</Caption>
        ) : (
          d.notes.map((n) => (
            <p key={n} className="break-words text-13">
              {n}
            </p>
          ))
        )}
      </Group>
      <Group title={t("ecosystem.link.writtenBy")}>
        <Tooltip
          label={t("ecosystem.link.writtenIds", {
            run: d.writtenBy.runId ?? t("ecosystem.link.unrecorded"),
            session: d.writtenBy.sessionId ?? t("ecosystem.link.unrecorded"),
            revision: record.revision,
          })}
          multiline
        >
          <span className="text-13">
            {d.writtenBy.runId ? t("ecosystem.link.byRun") : t("ecosystem.link.byMaster")}{" "}
            <span className="font-mono">{shortSha(d.writtenBy.sha)}</span>
          </span>
        </Tooltip>
        <span className="text-13">
          {t("ecosystem.link.refreshedAt")} <span className="font-mono">{shortSha(d.refreshedAtSha)}</span>
        </span>
        <span className="fg-caption">
          {record.currentVersion && record.currentVersion !== d.pinnedVersion
            ? t("ecosystem.link.pinsCurrent", { pinned: d.pinnedVersion, current: record.currentVersion })
            : t("ecosystem.link.pins", { pinned: d.pinnedVersion })}
        </span>
      </Group>
    </>
  );
}
