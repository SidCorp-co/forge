"use client";

import { Icon } from "@/design";
import { cn } from "@/lib/utils/cn";
import { type Eta, type EtaClock, etaInline, etaLines } from "../eta";

/** One ETA cell: the time right-aligned in tabular figures, the p85 or the release tail under it, the rest on hover. */
export function EtaCell({ eta, clock }: { eta: Eta | null; clock: EtaClock }) {
  if (!eta) return <span className="block text-right text-12 text-subtle" data-testid="eta-cell" data-kind="empty" />;
  const { line, sub } = etaLines(eta, clock);
  return (
    <span className="flex min-w-0 flex-col items-end text-right tabular-nums" title={eta.detail} data-testid="eta-cell" data-kind={eta.kind}>
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1 truncate text-12-5",
          eta.kind === "range" && "font-semibold text-fg",
          eta.kind === "waits" && "text-muted",
          (eta.kind === "done" || eta.kind === "none") && "text-subtle",
        )}
        data-testid="eta-line"
      >
        {eta.kind === "done" ? <Icon name="check" size={12} className="shrink-0" /> : null}
        <span className="truncate">{line}</span>
      </span>
      {sub ? (
        <span className="max-w-full truncate text-11 text-subtle" data-testid="eta-sub">
          {sub}
        </span>
      ) : null}
    </span>
  );
}

/** The ETA as the rail's one line, the durations and the as-of on hover. */
export function EtaInline({ eta, clock }: { eta: Eta; clock: EtaClock }) {
  return (
    <span
      className={cn("fg-body-sm tabular-nums", eta.kind === "range" ? "text-fg" : "text-muted")}
      title={eta.detail}
      data-testid="eta-inline"
      data-kind={eta.kind}
    >
      {etaInline(eta, clock)}
    </span>
  );
}
