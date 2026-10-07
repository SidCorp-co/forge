import { Button, PageTitle } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatDuration } from "../types";
import type { SessionStats } from "./session-filters";

/** Title, the four headline figures on one line, and Sweep (ISS-391). */
export function SessionsHeader({
  stats,
  sweeping,
  onSweep,
}: {
  stats: SessionStats;
  sweeping: boolean;
  onSweep: () => void;
}) {
  const t = useCopy();
  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
        <PageTitle className="fg-h2">{t("sessions.title")}</PageTitle>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatPill label={t("sessions.stat.active")} value={String(stats.active)} />
          <StatPill label={t("sessions.stat.queued")} value={String(stats.queued)} />
          <StatPill
            label={t("sessions.stat.zombies")}
            value={String(stats.zombies)}
            tone={stats.zombies > 0 ? "alert" : "default"}
          />
          <StatPill
            label={t("sessions.stat.medianWait")}
            value={stats.queued > 0 ? formatDuration(stats.medianWaitMs, t) : "—"}
          />
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        icon="trash"
        loading={sweeping}
        onClick={onSweep}
      >
        {t("sessions.sweep")}
      </Button>
    </header>
  );
}

/** Compact inline metric (ISS-391) — replaces the old big-number StatCard grid.
 *  `label: value` on one line; the value turns red in `alert` tone (e.g. zombie
 *  jobs > 0). */
function StatPill({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "alert";
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="fg-overline">{label}</span>
      <span
        className="fg-body-sm font-semibold tabular-nums"
        style={tone === "alert" ? { color: "var(--color-red)" } : undefined}
      >
        {value}
      </span>
    </span>
  );
}
