// The workspace's projects as a timeline (ISS-951 round 3, MK-10 C, the owner's choice): one lane per
// project over its last two hours, its master's passes as ticks, its runs as bars, its issues' status
// moves as dots and a dialog its pane stopped on as an amber bar, up to a dashed "now" edge. Beside
// it, the project's name with what it does (or why it took nothing) and, on the right, its pane badge
// and how fresh that is. With the peek open the lanes compress; the two columns stay whole.

import type { OrgActivityGroup, OrgActivityLane, OrgActivityProject } from "@forge/contracts/org-activity";
import { ORG_ACTIVITY_LANE_MINUTES } from "@forge/contracts/org-activity";
import { LEGEND, type LegendTone, TimelineAxis, TimelineGroupHeader, TimelineLegend, type TimelineMarks, TimelineRow, TimelineTrack, type useGroupFold } from "@/design";
import { useCopy, useCopyLocale } from "@/lib/i18n/interface-language";
import { Doing, PaneMark } from "./pane";

/** Where `at` falls on the lane, as a percentage from its start to the read's now. */
const at = (lane: OrgActivityLane, end: number) => (iso: string) => {
  const from = Date.parse(lane.from);
  return ((Date.parse(iso) - from) / (end - from)) * 100;
};

/** A lane's marks: runs and dialogs as bars to their end (or now), passes as ticks, moves as dots. */
export function laneMarks(lane: OrgActivityLane, generatedAt: string): TimelineMarks {
  const x = at(lane, Date.parse(generatedAt));
  const bar = (tone: "run" | "wait") => (s: { from: string; to: string | null }) => ({ key: `${tone}:${s.from}`, from: x(s.from), to: x(s.to ?? generatedAt), tone });
  return {
    bars: [...lane.runs.map(bar("run")), ...lane.dialogs.map(bar("wait"))],
    ticks: lane.passes.map((p) => ({ key: `pass:${p}`, at: x(p) })),
    // two moves at one instant are one dot
    dots: [...new Set(lane.moves)].map((m) => ({ key: `move:${m}`, at: x(m) })),
  };
}

/** The axis's times: the lane's start, each half hour, and "now". */
function Axis({ generatedAt }: { generatedAt: string }) {
  const t = useCopy();
  const locale = useCopyLocale();
  const end = Date.parse(generatedAt);
  const labels = [0, 30, 60, 90, 120].map((m) => ({
    key: String(m),
    at: (m / ORG_ACTIVITY_LANE_MINUTES) * 100,
    minor: m % 60 !== 0,
    text: m === 120 ? t("activity.lane.now") : new Date(end - (ORG_ACTIVITY_LANE_MINUTES - m) * 60_000).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
  }));
  return <TimelineAxis labels={labels} />;
}

/** Under the name: what the master does by name, else why its last pass took nothing; a dash where neither. */
function Under({ p }: { p: OrgActivityProject }) {
  const t = useCopy();
  if (p.master.doing) return <Doing master={p.master} />;
  if (p.next.skip) {
    return (
      <span className="truncate text-12" style={{ color: LEGEND.you.fg }} data-testid="activity-skip" title={t("activity.skip.title", { why: t(`activity.skip.${p.next.skip}`) })}>
        {t(`activity.skip.${p.next.skip}`)}
      </span>
    );
  }
  return <span className="text-12 text-subtle">—</span>;
}

export interface LaneGroup {
  id: OrgActivityGroup;
  label: string;
  tone: LegendTone;
  rows: OrgActivityProject[];
}

export function ActivityLanes({
  ariaLabel,
  groups,
  fold,
  generatedAt,
  now,
  hrefOf,
  selected,
  onPeek,
  empty,
}: {
  ariaLabel: string;
  groups: LaneGroup[];
  fold: ReturnType<typeof useGroupFold>;
  generatedAt: string;
  now: number;
  hrefOf: (slug: string) => string;
  selected: string | null;
  onPeek: (slug: string) => void;
  empty: string;
}) {
  const t = useCopy();
  const shown = groups.filter((g) => g.rows.length > 0);
  return (
    <section aria-label={ariaLabel} data-testid="activity-lanes">
      <TimelineLegend run={t("activity.legend.run")} tick={t("activity.legend.pass")} dot={t("activity.legend.move")} wait={t("activity.legend.dialog")} />
      <Axis generatedAt={generatedAt} />
      {shown.length === 0 ? <p className="px-5 py-8 text-13 text-subtle">{empty}</p> : null}
      {shown.map((g) => {
        const open = fold.isOpen(g.id);
        return (
          <div key={g.id}>
            <TimelineGroupHeader id={g.id} label={g.label} tone={g.tone} count={g.rows.length} open={open} onToggle={() => fold.toggle(g.id)} />
            {open
              ? g.rows.map((p) => (
                  <TimelineRow
                    key={p.slug}
                    rowKey={p.slug}
                    href={hrefOf(p.slug)}
                    selected={p.slug === selected}
                    onPeek={onPeek}
                    lead={
                      <>
                        <span className="truncate text-13-5 font-semibold">{p.name}</span>
                        <span className="flex min-w-0">
                          <Under p={p} />
                        </span>
                      </>
                    }
                    track={<TimelineTrack marks={p.lane ? laneMarks(p.lane, generatedAt) : null} empty={t("activity.lane.noMaster")} />}
                    trail={<PaneMark master={p.master} now={now} />}
                  />
                ))
              : null}
          </div>
        );
      })}
    </section>
  );
}
