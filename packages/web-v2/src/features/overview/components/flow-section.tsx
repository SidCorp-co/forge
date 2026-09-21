"use client";

import {
  Card,
  CardContent,
  SectionTitle,
  StreamBand,
} from "@/design";
import type { PulseFlowWeek } from "../types";

export interface FlowSectionProps {
  flow: PulseFlowWeek[];
}

/** Section 4 — which way is the flow going? */
export function FlowSection({ flow }: FlowSectionProps) {
  if (flow.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2">
          <SectionTitle className="fg-h3">Which way the flow is going</SectionTitle>
          <p className="fg-body-sm text-muted">No weekly series in this response.</p>
        </CardContent>
      </Card>
    );
  }

  const first = flow[0];
  const last = flow[flow.length - 1];
  const startBacklog = first.backlog - first.created + first.closed - first.reopened;
  const drift = last.backlog - startBacklog;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionTitle className="fg-h3">Which way the flow is going</SectionTitle>
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
          outboundLabel="Finished"
          lineLabel="Backlog left behind"
          label={`${flow.length} weeks of issues created against issues finished. Backlog went from ${startBacklog} to ${last.backlog}.`}
        />
      </CardContent>
    </Card>
  );
}
