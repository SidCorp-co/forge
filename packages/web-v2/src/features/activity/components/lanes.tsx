// The workspace's projects as a timeline (ISS-979, the owner's mockup v3): one lane per project over its
// last two hours, grouped where core put it (Waiting on you first, then Working, Idle, Paused, No master)
// under the shared group header, each lane indented under it. Left, the project's name and its state
// with what it has queued (why it stands so is the state's tooltip); in the middle its runs as bars, its
// status moves in batches, its releases as diamonds and what waits on the reader as amber pins, each
// opening a popover; right, the reader's count to answer and when the project last moved.

import type { OrgActivityLane, OrgActivityProject, OrgActivityStanding } from "@forge/contracts/org-activity";
import { useRef, useState } from "react";
import {
  GroupHeader,
  type LegendTone,
  TimelineFrame,
  TimelineHead,
  spreadMarks,
  TimelineMark,
  TimelineRow,
  type TimelineRun,
  TimelineTrack,
  Tooltip,
  type useGroupFold,
} from "@/design";
import { useCopy, useCopyLocale } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { Link } from "@/lib/navigation/router";
import { MarkPopover, type OpenMark, useMarkWords } from "./marks";
import { agoText } from "./pane";

export interface LaneGroup {
  id: string;
  label: string;
  tone: LegendTone;
  rows: OrgActivityProject[];
}

/** What each mark is drawn as: a state's diamond tone. */
const RELEASE_TONE = { released: "ok", releasing: "info", failed: "danger", stopped: "neutral" } as const;

/** A standing's dot under the name. */
const STANDING_DOT: Record<OrgActivityStanding, string> = { working: "bg-info-9", idle: "bg-neutral-8", paused: "bg-neutral-6", none: "bg-danger-9" };

/** Where a time falls on the lane, as a percentage from its start to the read's now. */
export const placeOn = (lane: OrgActivityLane, generatedAt: string) => {
  const from = Date.parse(lane.from);
  const span = Date.parse(generatedAt) - from;
  return (iso: string) => ((Date.parse(iso) - from) / span) * 100;
};

/** Each half hour on the clock inside the lane, as a time. */
export function halfHours(from: string, to: string): number[] {
  const start = new Date(from);
  start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0);
  const out: number[] = [];
  for (let t = start.getTime(); t <= Date.parse(to); t += 30 * 60_000) out.push(t);
  return out;
}

/** Why a row stands where it does, for its state's tooltip: why it is paused, what its master works on, or why it took nothing. */
function reasonOf(p: OrgActivityProject, t: Copy): string | null {
  if (p.pause) return t(`activity.pause.${p.pause}`);
  const d = p.master.doing;
  if (d?.issueTitle) return d.issueTitle;
  if (p.next.skip) return t("activity.skip.title", { why: t(`activity.skip.${p.next.skip}`) });
  return null;
}

function Lead({ p, href, onPeek }: { p: OrgActivityProject; href: string; onPeek: () => void }) {
  const t = useCopy();
  const reason = reasonOf(p, t);
  const state = (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 text-12 text-muted" data-testid="activity-state" data-standing={p.standing}>
      <i aria-hidden className={`inline-block size-2 flex-none rounded-full ${STANDING_DOT[p.standing]}`} />
      {t(`activity.group.${p.standing}`)}
      <span className="whitespace-nowrap text-subtle">· {t("activity.queued", { n: p.next.total })}</span>
    </span>
  );
  return (
    <>
      <Link
        href={href}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          onPeek();
        }}
        className="truncate text-14 font-semibold text-fg no-underline hover:underline"
        data-testid="activity-name"
      >
        {p.name}
      </Link>
      {reason ? (
        <Tooltip label={reason} multiline focusable className="min-w-0">
          {state}
        </Tooltip>
      ) : (
        state
      )}
    </>
  );
}

function Track({ p, generatedAt, batches, open, onOpen }: { p: OrgActivityProject; generatedAt: string; batches: boolean; open: OpenMark | null; onOpen: (m: OpenMark, el: HTMLElement) => void }) {
  const t = useCopy();
  const w = useMarkWords();
  const lane = p.lane;
  const x = placeOn(lane, generatedAt);
  const anchorsRef = useRef(new Map<string, HTMLElement>());
  const ref = (id: string) => (el: HTMLButtonElement | null) => void (el ? anchorsRef.current.set(id, el) : anchorsRef.current.delete(id));
  const fire = (id: string, m: OpenMark) => () => {
    const el = anchorsRef.current.get(id);
    if (el) onOpen(m, el);
  };
  const isOpen = (kind: OpenMark["kind"], at: string) => open?.project.projectId === p.projectId && open.kind === kind && (open.kind === "batch" ? open.batch.at : open.kind === "release" ? open.release.at : open.since) === at;
  const runs: TimelineRun[] = lane.runs.map((r) => ({
    key: r.from,
    from: x(r.from),
    to: x(r.to ?? generatedAt),
    live: r.to === null,
    title: r.to === null ? t("activity.run.live", { from: w.clock(r.from) }) : t("activity.run.past", { from: w.clock(r.from), to: w.clock(r.to) }),
  }));
  const spots = spreadMarks([
    ...(batches ? lane.batches.map((b) => ({ key: `b:${b.at}`, at: x(b.at), pin: false })) : []),
    ...lane.releases.map((r) => ({ key: `r:${r.version}`, at: x(r.at), pin: false })),
    ...lane.waits.map((wt) => ({ key: `w:${wt.at}`, at: x(wt.at), pin: true })),
  ]);
  return (
    <TimelineTrack ticks={halfHours(lane.from, generatedAt).map((h) => x(new Date(h).toISOString()))} runs={runs}>
      {batches
        ? lane.batches.map((b) => (
            <TimelineMark
              key={`b:${b.at}`}
              at={x(b.at)}
              shape={{ kind: "count", n: b.moves.length }}
              lowered={spots.get(`b:${b.at}`)?.lowered}
              shift={spots.get(`b:${b.at}`)?.shift}
              label={w.batchTip(b)}
              open={isOpen("batch", b.at)}
              markRef={ref(`b:${b.at}`)}
              onOpen={fire(`b:${b.at}`, { kind: "batch", project: p, batch: b })}
              testId="mark-batch"
            />
          ))
        : null}
      {lane.releases.map((r) => (
        <TimelineMark
          key={`r:${r.version}`}
          at={x(r.at)}
          shape={{ kind: "diamond", tone: RELEASE_TONE[r.state] }}
          lowered={spots.get(`r:${r.version}`)?.lowered}
          shift={spots.get(`r:${r.version}`)?.shift}
          label={w.releaseTip(r)}
          open={isOpen("release", r.at)}
          markRef={ref(`r:${r.version}`)}
          onOpen={fire(`r:${r.version}`, { kind: "release", project: p, release: r })}
          testId="mark-release"
        />
      ))}
      {lane.waits.map((wt) => (
        <TimelineMark
          key={`w:${wt.at}`}
          at={x(wt.at)}
          shape={{ kind: "pin", n: wt.items.length + wt.more }}
          label={w.waitTip(wt.items)}
          open={isOpen("wait", wt.at)}
          markRef={ref(`w:${wt.at}`)}
          onOpen={fire(`w:${wt.at}`, { kind: "wait", project: p, items: wt.items, since: wt.at, more: wt.more })}
          testId="mark-wait"
        />
      ))}
    </TimelineTrack>
  );
}

/** The reader's count to answer, amber, opening every item it holds; a dash where nothing waits. */
function YouCount({ p, onOpen }: { p: OrgActivityProject; onOpen: (m: OpenMark, el: HTMLElement) => void }) {
  const t = useCopy();
  if (p.people.total === 0) return <span className="text-subtle">–</span>;
  const since = p.lane.waits[0]?.at ?? p.lane.from;
  return (
    <button
      type="button"
      title={t("activity.legend.you")}
      aria-label={`${t("activity.legend.you")}: ${p.people.total}`}
      onClick={(e) => onOpen({ kind: "wait", project: p, items: p.people.items, since, more: p.people.total - p.people.items.length }, e.currentTarget)}
      className="inline-flex h-5 min-w-6 items-center justify-center rounded-full border border-warn-9 bg-warn-3 px-1.5 text-12 font-semibold text-warn-11 tabular-nums hover:brightness-105"
      data-testid="activity-you"
    >
      {p.people.total}
    </button>
  );
}

export function ActivityLanes({
  ariaLabel,
  groups,
  fold,
  generatedAt,
  now,
  batches,
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
  batches: boolean;
  hrefOf: (slug: string) => string;
  selected: string | null;
  onPeek: (slug: string) => void;
  empty: string;
}) {
  const t = useCopy();
  const locale = useCopyLocale();
  const [open, setOpen] = useState<OpenMark | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const openMark = (m: OpenMark, el: HTMLElement) => {
    anchorRef.current = el;
    setOpen(m);
  };
  const shown = groups.filter((g) => g.rows.length > 0);
  const from = new Date(Date.parse(generatedAt) - 120 * 60_000).toISOString();
  const end = Date.parse(generatedAt);
  const ticks = halfHours(from, generatedAt)
    // a label too near "now" would print over it
    .filter((h) => (end - h) / (end - Date.parse(from)) > 0.06)
    .map((h) => ({ key: String(h), at: ((h - Date.parse(from)) / (end - Date.parse(from))) * 100, text: new Date(h).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }));
  return (
    <TimelineFrame label={ariaLabel}>
      <TimelineHead lead={t("activity.col.project")} ticks={ticks} now={t("activity.lane.now")} trail={[t("activity.col.you"), t("activity.col.last")]} />
      {shown.length === 0 ? <p className="px-5 py-8 text-13 text-subtle">{empty}</p> : null}
      {shown.map((g) => {
        const isOpen = fold.isOpen(g.id);
        return (
          <div key={g.id} data-testid="activity-group">
            <GroupHeader id={g.id} label={g.label} count={g.rows.length} tone={g.tone} open={isOpen} onToggle={() => fold.toggle(g.id)} />
            {isOpen
              ? g.rows.map((p) => (
                  <TimelineRow
                    key={p.slug}
                    rowKey={p.slug}
                    selected={p.slug === selected}
                    lead={<Lead p={p} href={hrefOf(p.slug)} onPeek={() => onPeek(p.slug)} />}
                    track={<Track p={p} generatedAt={generatedAt} batches={batches} open={open} onOpen={openMark} />}
                    you={<YouCount p={p} onOpen={openMark} />}
                    last={<span data-testid="activity-last">{p.lastActivityAt ? agoText(t, p.lastActivityAt, now) : "—"}</span>}
                  />
                ))
              : null}
          </div>
        );
      })}
      <MarkPopover mark={open} anchor={anchorRef} onClose={() => setOpen(null)} />
    </TimelineFrame>
  );
}
