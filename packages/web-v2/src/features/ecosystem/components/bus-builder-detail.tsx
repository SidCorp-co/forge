"use client";

import { enumLabel, StatusBadge, Tooltip } from "@/design";
import { readingOf } from "@/lib/api/refusals";
import { formatRelativeTime } from "@/lib/utils/format";
import { type Bus, callSiteAt, triggerRef } from "../bus";
import { useBuilderRun } from "../hooks";
import { ProjectMark } from "./bus-diagram";
import { Caption, Group, Head, Steps } from "./bus-detail-kit";
import { Loading, UnreadNotice } from "./notices";

export function BuilderDetail({ bus, id }: { bus: Bus; id: string }) {
  const p = bus.projects.find((x) => x.id === id);
  const reading = readingOf(useBuilderRun(p?.id, p?.builder?.id));
  if (!p?.builder) return <Caption>No builder run is recorded for that project in this ecosystem.</Caption>;
  return (
    <>
      <Head>
        <ProjectMark slug={p.slug} size={22} />
        <h2 className="text-15 font-semibold">{p.slug} ecosystem builder</h2>
        <Tooltip label={`Run ${p.builder.id}`}>
          <span className="fg-caption">
            on {enumLabel("trigger", p.builder.trigger.kind).toLowerCase()} at <span className="font-mono">{triggerRef(p.builder.trigger)}</span> ·{" "}
            {formatRelativeTime(p.builder.updatedAt)}
          </span>
        </Tooltip>
      </Head>
      <Group title="Steps">
        <Steps builder={p.builder} />
      </Group>
      <Group title="Found" aside={p.builder.findings || undefined}>
        {reading.kind === "loading" ? <Loading what="what the builder found" /> : null}
        {reading.kind === "unread" ? (
          <UnreadNotice what={`${p.slug}'s builder findings`} refusals={reading.refusals} />
        ) : null}
        {reading.kind === "read" ? (
          reading.value.document.findings.length === 0 ? (
            <Caption>The builder has found no outbound call yet.</Caption>
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
      <Group title="Links written" aside={p.builder.links || undefined}>
        <Caption>
          {p.builder.links === 0
            ? "None yet."
            : `${p.builder.links} link${p.builder.links === 1 ? "" : "s"}, shown on the bus under ${p.slug}.`}
        </Caption>
      </Group>
    </>
  );
}
