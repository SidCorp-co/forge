// The engineers' three figures on the Development overview: active runs, open issues, spend today
// (the BA's Dashboard keeps requirements, feedback and releases).
// Presentational only: every value arrives from a hook the page already called.

"use client";

import { PageSection, PageSectionBody, Icon, type IconName } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

interface Kpi {
  icon: IconName;
  label: string;
  value: string;
  /** Omitted where a tile has nothing true to say under its figure — the row keeps its rhythm
      because every tile is the same height, and a blank line beats an invented one. */
  caption?: string;
  /** Render the value in the accent color (a live signal worth the eye). */
  accent?: boolean;
}

export interface KpiBandProps {
  liveRuns: number;
  busyRunners: number;
  onlineRunners: number;
  openIssues: number;
  spendTodayUsd: number;
  inFlightUsd: number;
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function KpiBand(props: KpiBandProps) {
  const t = useCopy();
  const kpis: Kpi[] = [
    {
      icon: "pipeline",
      label: t("overview.kpi.activeRuns"),
      value: String(props.liveRuns),
      caption: t("overview.kpi.runnersBusy", { busy: props.busyRunners, online: props.onlineRunners }),
      accent: props.liveRuns > 0,
    },
    {
      icon: "board",
      label: t("overview.kpi.openIssues"),
      value: String(props.openIssues),
    },
    {
      icon: "dollar",
      label: t("overview.kpi.spendToday"),
      value: money(props.spendTodayUsd),
      caption: props.inFlightUsd > 0 ? t("overview.kpi.inFlight", { usd: money(props.inFlightUsd) }) : t("overview.kpi.trailing"),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-x-8 lg:grid-cols-3">
      {kpis.map((k) => (
        <PageSection key={k.label}>
          <PageSectionBody>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-[5px] text-subtle" style={{ fontSize: "var(--text-12-5)" }}>
                <Icon name={k.icon} size={14} style={{ color: "var(--fg-subtle)" }} />
                {k.label}
              </span>
            </div>
            <p
              className="mt-2 font-mono text-2xl font-bold tabular-nums"
              style={{ color: k.accent ? "var(--accent-text)" : "var(--fg-default)" }}
            >
              {k.value}
            </p>
            {k.caption && <p className="fg-caption mt-0.5 text-subtle">{k.caption}</p>}
          </PageSectionBody>
        </PageSection>
      ))}
    </div>
  );
}
