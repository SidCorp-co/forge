// 5-KPI band for the per-project dashboard (ISS-379, AC#1). Active runs, Needs
// you, Open issues, Spend today, and a deferred Pass-rate slot (ISS-380 Part 2).
// All values come from already-fetched hooks — this is presentational only.
import { Card, CardContent, Icon, type IconName } from "@/design";
import { Badge } from "@/design/primitives/badge";

interface Kpi {
  icon: IconName;
  label: string;
  value: string;
  caption: string;
  /** Render the value in the accent color (a live signal worth the eye). */
  accent?: boolean;
  /** Deferred metric — dims the value and shows a "soon" badge instead. */
  pending?: boolean;
}

export interface KpiBandProps {
  liveRuns: number;
  busyRunners: number;
  onlineRunners: number;
  needsYou: number;
  openIssues: number;
  activeStages: number;
  spendTodayUsd: number;
  inFlightUsd: number;
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function KpiBand(props: KpiBandProps) {
  const kpis: Kpi[] = [
    {
      icon: "pipeline",
      label: "Active runs",
      value: String(props.liveRuns),
      caption: `${props.busyRunners}/${props.onlineRunners} runners busy`,
      accent: props.liveRuns > 0,
    },
    {
      icon: "inbox",
      label: "Needs you",
      value: String(props.needsYou),
      caption: "blocked · failed · review",
      accent: props.needsYou > 0,
    },
    {
      icon: "board",
      label: "Open issues",
      value: String(props.openIssues),
      caption: `across ${props.activeStages} stage${props.activeStages === 1 ? "" : "s"}`,
    },
    {
      icon: "dollar",
      label: "Spend today",
      value: money(props.spendTodayUsd),
      caption: props.inFlightUsd > 0 ? `+${money(props.inFlightUsd)} in flight` : "trailing 24h",
    },
    {
      icon: "check",
      label: "Pass rate",
      value: "—",
      caption: "7d · coming soon (ISS-380)",
      pending: true,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {kpis.map((k) => (
        <Card key={k.label}>
          <CardContent>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-[5px] text-subtle" style={{ fontSize: 12.5 }}>
                <Icon name={k.icon} size={14} style={{ color: "var(--fg-subtle)" }} />
                {k.label}
              </span>
              {k.pending && <Badge tone="neutral">soon</Badge>}
            </div>
            <p
              className="mt-2 font-mono text-2xl font-bold tabular-nums"
              style={{ color: k.pending ? "var(--fg-subtle)" : k.accent ? "var(--accent-text)" : "var(--fg-default)" }}
            >
              {k.value}
            </p>
            <p className="fg-caption mt-0.5 text-subtle">{k.caption}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
