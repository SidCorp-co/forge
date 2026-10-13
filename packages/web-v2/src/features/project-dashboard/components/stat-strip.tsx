// The figures row: four figures, flush, divided by hairlines, each with what it is measured against.
// Pass rate has no data yet and is not a figure here (ISS-380, `ComingSoonNote`).

import { OPEN_WORK_LABEL } from "@forge/contracts/work-state";

interface Stat {
  label: string;
  value: string;
  /** Under the figure: what it is measured against. Omitted where the data holds nothing to measure against. */
  caption?: string;
  /** The figure carries a live signal worth the eye. */
  accent?: boolean;
}

export interface StatStripProps {
  liveRuns: number;
  /** The runs read has not arrived or failed: no run count is stated. */
  runsUnread?: boolean;
  /** Runs open in all, as the navigation rail counts them; the figure says when it counts fewer. */
  openRuns?: number;
  /** The runners read has not arrived or failed: no runner count is stated. */
  runnersUnread?: boolean;
  busyRunners: number;
  onlineRunners: number;
  needsYou: number;
  /** What the figure counts, by kind. */
  needsYouCaption: string;
  /** Oldest wait among the items listed, already worded; null where none carries a time. */
  oldestWait: string | null;
  /** Said in place of the figure where the response cannot support one. */
  needsYouRefusal?: string | null;
  /** The attention answer is not in yet: no figure is stated. */
  needsYouPending?: boolean;
  openWork: number;
  /** What the open count is made of, since the data holds no history to compare it with. */
  openWorkMadeOf: string;
  spendTodayUsd: number;
  spendComparison: string | null;
  inFlightUsd: number;
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function runsCaption(props: StatStripProps): string {
  if (props.runsUnread) return "runs not read";
  const runners = props.runnersUnread
    ? "runners not read"
    : `${props.busyRunners} of ${props.onlineRunners} runners busy`;
  const open = props.openRuns ?? props.liveRuns;
  return open > props.liveRuns ? `${runners} · ${open} runs open in all` : runners;
}

export function StatStrip(props: StatStripProps) {
  const needsGap = props.needsYouPending || props.needsYouRefusal;
  const stats: Stat[] = [
    {
      label: "Runs live",
      value: props.runsUnread ? "…" : String(props.liveRuns),
      caption: runsCaption(props),
      accent: !props.runsUnread && props.liveRuns > 0,
    },
    {
      label: "Needs you",
      value: props.needsYouPending ? "…" : props.needsYouRefusal ? "—" : String(props.needsYou),
      caption: props.needsYouPending
        ? "reading what needs you…"
        : (props.needsYouRefusal ??
          [props.oldestWait ? `oldest ${props.oldestWait}` : null, props.needsYouCaption].filter(Boolean).join(" · ")),
      accent: !needsGap && props.needsYou > 0,
    },
    { label: OPEN_WORK_LABEL, value: String(props.openWork), caption: props.openWorkMadeOf },
    {
      label: "Spend, 24h",
      value: money(props.spendTodayUsd),
      caption:
        [props.spendComparison, props.inFlightUsd > 0 ? `+${money(props.inFlightUsd)} in flight` : null]
          .filter(Boolean)
          .join(" · ") || undefined,
    },
  ];

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4" aria-label="Figures">
      {stats.map((s) => (
        <div key={s.label} className="min-w-0 sm:border-l sm:border-line-subtle sm:pl-5 sm:first:border-l-0 sm:first:pl-0">
          <dt className="fg-caption text-subtle">{s.label}</dt>
          <dd
            className="mt-0.5 font-mono text-2xl font-bold tabular-nums"
            style={{ color: s.accent ? "var(--accent-text)" : "var(--fg-default)" }}
          >
            {s.value}
          </dd>
          {s.caption && <dd className="fg-caption mt-0.5 text-subtle">{s.caption}</dd>}
        </div>
      ))}
    </dl>
  );
}
