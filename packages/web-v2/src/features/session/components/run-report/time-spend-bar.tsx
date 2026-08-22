// "Where the time went" — the run's wall clock as one proportional bar.
//
// Deliberately NOT a second copy of the pipeline step strip at the top of the
// page: that answers "which steps ran", this answers "which part of THIS step
// burned the three minutes". A run that spent 2m queued and 12s working is the
// single most actionable shape here, and no step strip can show it.
import { formatDurationMs } from "@/features/pipeline/derive";
import type { TimeSpanKey, TimeSpend } from "../../run-report";

const SPAN_COLOR: Record<TimeSpanKey, string> = {
  queued: "var(--paper-300)",
  startup: "var(--slate-500)",
  agent: "var(--cobalt-500)",
};

function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function TimeSpendBar({ spend }: { spend: TimeSpend }) {
  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4 shadow-sm">
      <div className="flex items-baseline gap-2.5">
        <span className="fg-overline">Where the time went</span>
        <span className="fg-caption ml-auto">
          {clockOf(spend.from)} → {clockOf(spend.to)} · {formatDurationMs(spend.totalMs)} wall
        </span>
      </div>
      <div className="mt-2.5 flex h-3 gap-0.5 overflow-hidden rounded-pill">
        {spend.spans.map((span) => (
          <i
            key={span.key}
            className="block"
            style={{ flex: span.ms, background: SPAN_COLOR[span.key] }}
            title={`${span.label} — ${formatDurationMs(span.ms)}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {spend.spans.map((span) => (
          <span key={span.key} className="fg-caption">
            <b className="fg-body-sm">{formatDurationMs(span.ms)}</b> {span.label}{" "}
            <em className="not-italic opacity-70">{clockOf(span.at)}</em>
          </span>
        ))}
      </div>
    </section>
  );
}
