"use client";

import {
  SectionTitle,
  StreamBand,
} from "@/design";
import { WORK_STATE_LABELS } from "@forge/contracts/work-state";
import type { PulseFlowWeek } from "../types";

export interface FlowSectionProps {
  flow: PulseFlowWeek[];
}

/** Section 4 — which way is the flow going? */
export function FlowSection({ flow }: FlowSectionProps) {
  if (flow.length === 0) {
    return (
      <section aria-labelledby="overview-flow" className="flex flex-col gap-2 border-t border-line pt-5">
        <SectionTitle id="overview-flow" className="fg-h3">Which way the flow is going</SectionTitle>
        <p className="fg-body-sm text-muted">No weekly series in this response.</p>
      </section>
    );
  }

  const first = flow[0];
  const last = flow[flow.length - 1];
  const startBacklog = first.backlog - first.created + first.closed - first.reopened;
  const drift = last.backlog - startBacklog;

  return (
    <section aria-labelledby="overview-flow" className="flex flex-col gap-3 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle id="overview-flow" className="fg-h3">Which way the flow is going</SectionTitle>
        <p className="fg-body-sm text-muted">
          Backlog {drift === 0 ? "unchanged" : drift > 0 ? `up ${drift}` : `down ${-drift}`} over{" "}
          {flow.length} weeks — {startBacklog} to {last.backlog}
        </p>
      </div>
      <StreamBand
        weeks={flow.map((w) => ({
          key: w.weekStart,
          inbound: w.created,
          outbound: w.closed,
          line: w.backlog,
        }))}
        inboundLabel="Created"
        outboundLabel={WORK_STATE_LABELS.finished}
        lineLabel="Backlog left behind"
        label={`${flow.length} weeks of issues created against issues finished. Backlog went from ${startBacklog} to ${last.backlog}.`}
      />
    </section>
  );
}
