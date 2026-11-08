
import { Icon } from "@/design";
import { cn } from "@/lib/utils/cn";
import { type Eta, type EtaClock, etaDay, etaInline, etaLines } from "../eta";

/** One ETA cell in one format, a date or "Shipped v" (`etaDay`), the rest on hover. */
function EtaDayCell({ eta, clock }: { eta: Eta; clock: EtaClock }) {
  const day = etaDay(eta, clock);
  if (!day) return <span className="block text-right text-12 text-subtle" title={eta.detail} data-testid="eta-cell" data-kind="empty" />;
  return (
    <span className="flex min-w-0 justify-end text-right tabular-nums max-md:justify-start max-md:text-left" title={eta.detail} data-testid="eta-cell" data-kind={eta.kind}>
      <span className={cn("max-w-full truncate text-13", eta.kind === "range" ? "font-semibold text-fg" : "text-subtle", day.late && "text-danger")} data-testid="eta-line">
        {day.line}
      </span>
    </span>
  );
}

/**
 * One ETA cell: the time right-aligned in tabular figures, the p85 or the release tail under it, the
 * rest on hover. `day` draws it in one format, a date or "Shipped v", where a list reads one (FB-583).
 */
export function EtaCell({ eta, clock, day = false }: { eta: Eta | null; clock: EtaClock; day?: boolean }) {
  if (!eta) return <span className="block text-right text-12 text-subtle" data-testid="eta-cell" data-kind="empty" />;
  if (day) return <EtaDayCell eta={eta} clock={clock} />;
  const { line, sub, late, also } = etaLines(eta, clock);
  return (
    // one ETA on the row (ISS-1072): the latest it may run to rides the tooltip with the detail
    <span className="flex min-w-0 flex-col items-end text-right tabular-nums max-md:items-start max-md:text-left" title={[sub, eta.detail].filter(Boolean).join(" · ")} data-testid="eta-cell" data-kind={eta.kind}>
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1 truncate text-13",
          eta.kind === "range" && !late && "font-semibold text-fg",
          late && "font-semibold text-danger",
          (eta.kind === "waits" || eta.kind === "landed" || eta.kind === "judging") && "text-muted",
          (eta.kind === "done" || eta.kind === "none" || eta.kind === "shipped") && "text-subtle",
        )}
        data-testid="eta-line"
      >
        {eta.kind === "done" ? <Icon name="check" size={12} className="shrink-0" /> : null}
        <span className="truncate">{line}</span>
      </span>
      {also ? (
        <span className="max-w-full truncate text-12 text-muted" data-testid="eta-also">
          {also}
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
