"use client";

import { enumLabel, ProjectMark, StatusBadge, Tooltip } from "@/design";
import { readingOf } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatRelativeTime } from "@/lib/utils/format";
import { type Bus, callSiteAt, triggerRef, projectMarkProps } from "../bus";
import { useBuilderRun } from "../hooks";
import { Caption, Group, Head, Steps } from "./bus-detail-kit";
import { Loading, UnreadNotice } from "./notices";

export function BuilderDetail({ bus, id }: { bus: Bus; id: string }) {
  const t = useCopy();
  const p = bus.projects.find((x) => x.id === id);
  const reading = readingOf(useBuilderRun(p?.id, p?.builder?.id));
  if (!p?.builder) return <Caption>{t("ecosystem.builder.noRun")}</Caption>;
  return (
    <>
      <Head>
        <ProjectMark {...projectMarkProps(p.slug)} size={22} />
        <h2 className="text-15 font-semibold">{t("ecosystem.builder.title", { slug: p.slug })}</h2>
        <Tooltip label={t("ecosystem.builder.run", { id: p.builder.id })}>
          <span className="fg-caption">
            {t("ecosystem.builder.onTrigger", { trigger: enumLabel("trigger", p.builder.trigger.kind).toLowerCase() })}{" "}
            <span className="font-mono">{triggerRef(p.builder.trigger, t)}</span> ·{" "}
            {formatRelativeTime(p.builder.updatedAt)}
          </span>
        </Tooltip>
      </Head>
      <Group title={t("ecosystem.builder.steps")}>
        <Steps builder={p.builder} />
      </Group>
      <Group title={t("ecosystem.builder.found")} aside={p.builder.findings || undefined}>
        {reading.kind === "loading" ? <Loading what={t("ecosystem.builder.findingsWhat", { slug: p.slug })} /> : null}
        {reading.kind === "unread" ? (
          <UnreadNotice what={t("ecosystem.builder.findingsWhat", { slug: p.slug })} refusals={reading.refusals} />
        ) : null}
        {reading.kind === "read" ? (
          reading.value.document.findings.length === 0 ? (
            <Caption>{t("ecosystem.builder.noCalls")}</Caption>
          ) : (
            reading.value.document.findings.map((f) => (
              <Tooltip
                key={`${callSiteAt(f.site)}:${f.site.operation}`}
                label={`${callSiteAt(f.site)} · ${f.site.operation}`}
                multiline
              >
                <span className="flex min-w-0 justify-between gap-2 font-mono text-11-5">
                  <span className="truncate" style={{ color: "var(--cobalt-700)" }}>
                    {f.classification === "matched"
                      ? f.contract.slug
                      : f.classification === "outside_ecosystem"
                        ? f.host
                        : f.site.operation}
                  </span>
                  <StatusBadge family="finding" value={f.classification} />
                </span>
              </Tooltip>
            ))
          )
        ) : null}
      </Group>
      <Group title={t("ecosystem.builder.links")} aside={p.builder.links || undefined}>
        {p.builder.links === 0 ? <Caption>{t("ecosystem.builder.linksNone")}</Caption> : null}
      </Group>
    </>
  );
}
