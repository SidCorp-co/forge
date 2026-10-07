"use client";

import {
  PageSection,
  PageSectionBody,
  SectionTitle,
  StreamBand,
} from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { PulseFlowWeek } from "../types";

export interface FlowSectionProps {
  flow: PulseFlowWeek[];
}

/** Section 4 — which way is the flow going? */
export function FlowSection({ flow }: FlowSectionProps) {
  const t = useCopy();
  if (flow.length === 0) {
    return (
      <PageSection>
        <PageSectionBody className="flex flex-col gap-2">
          <SectionTitle className="fg-h3">{t("overview.flowWeeks.title")}</SectionTitle>
          <p className="fg-body-sm text-muted">{t("overview.flowWeeks.empty")}</p>
        </PageSectionBody>
      </PageSection>
    );
  }

  const first = flow[0];
  const last = flow[flow.length - 1];
  const startBacklog = first.backlog - first.created + first.closed - first.reopened;
  const drift = last.backlog - startBacklog;

  return (
    <PageSection>
      <PageSectionBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionTitle className="fg-h3">{t("overview.flowWeeks.title")}</SectionTitle>
          <p className="fg-body-sm text-muted">
            {t(drift === 0 ? "overview.flowWeeks.unchanged" : drift > 0 ? "overview.flowWeeks.up" : "overview.flowWeeks.down", { n: Math.abs(drift), weeks: flow.length, from: startBacklog, to: last.backlog })}
          </p>
        </div>
        <StreamBand
          weeks={flow.map((w) => ({
            key: w.weekStart,
            inbound: w.created,
            outbound: w.closed,
            line: w.backlog,
          }))}
          inboundLabel={t("overview.flowWeeks.created")}
          outboundLabel={t("overview.flowWeeks.finished")}
          lineLabel={t("overview.flowWeeks.backlog")}
          label={t("overview.flowWeeks.aria", { weeks: flow.length, from: startBacklog, to: last.backlog })}
        />
      </PageSectionBody>
    </PageSection>
  );
}
