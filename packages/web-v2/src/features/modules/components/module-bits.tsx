"use client";

import { ISSUE_ATTENTION_LABELS } from "@forge/contracts/issue-standing";
import { MODULE_ATTENTION_LABELS, MODULE_OPEN_KINDS } from "@forge/contracts/modules";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type BannerTone, Button, type CoverageSegment, LEGEND, ToneBadge, WaitBanner, type WaitingOnView } from "@/design";
import { issueWaitingView } from "@/features/issues/components/issue-standing-bits";
import { issueHref } from "@/features/issues/routes";
import { formatStamp } from "@/lib/utils/format";
import type { ModuleAttentionGroup, ModuleActivityDay, ModuleLanding, ModuleStanding, ModuleWaitingOn } from "../types";

const DAY_MS = 86_400_000;

export function AttentionBadge({ group }: { group: ModuleAttentionGroup }) {
  const m = MODULE_ATTENTION_LABELS[group];
  return <ToneBadge tone={m.tone} label={m.label} value={group} pulse={group === "moving"} title={`${group} · ${m.hint}`} />;
}

export const openSegments = (s: ModuleStanding): CoverageSegment[] =>
  MODULE_OPEN_KINDS.map((k) => ({
    key: k,
    label: ISSUE_ATTENTION_LABELS[k].label,
    count: s.openByKind[k],
    tone: ISSUE_ATTENTION_LABELS[k].tone,
    hint: ISSUE_ATTENTION_LABELS[k].hint,
  }));

export function landingAge(l: ModuleLanding, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(l.landedAt).getTime()) / DAY_MS));
}

function RecencyDot({ landing }: { landing: ModuleLanding | null }) {
  const days = landing ? landingAge(landing) : null;
  const colour = days === null ? "var(--paper-300)" : days <= 2 ? LEGEND.ready.dot : days <= 7 ? "var(--ink-400)" : "var(--paper-400)";
  const title = landing ? `Last landing ${landing.issueKey} · ${formatStamp(landing.landedAt)} (${days} d ago)` : "Nothing has landed in this module yet";
  return <span role="img" aria-label={title} title={title} className="size-2 flex-none rounded-full" style={{ background: colour }} data-testid="recency-dot" />;
}

/** Open issues by state on one scale across the list, the dot ahead of it the recency of the last landing. */
export function OpenBar({ standing, max }: { standing: ModuleStanding; max: number }) {
  const parts = MODULE_OPEN_KINDS.filter((k) => standing.openByKind[k] > 0);
  const text = parts.length ? parts.map((k) => `${ISSUE_ATTENTION_LABELS[k].label} ${standing.openByKind[k]}`).join(" · ") : "Nothing open";
  return (
    <span className="inline-flex w-full items-center gap-2" data-testid="open-bar">
      <RecencyDot landing={standing.lastLanding} />
      <span
        role="img"
        aria-label={text}
        title={text}
        className="flex h-2 max-w-[110px] flex-1 overflow-hidden rounded-pill bg-[var(--paper-200)]"
      >
        {parts.map((k) => (
          <span
            key={k}
            className="h-full"
            style={{ width: `${(standing.openByKind[k] / Math.max(1, max)) * 100}%`, background: LEGEND[ISSUE_ATTENTION_LABELS[k].tone].dot }}
          />
        ))}
      </span>
    </span>
  );
}

export function ActivityBars({ days, height = 28, barWidth = 8 }: { days: ModuleActivityDay[]; height?: number; barWidth?: number }) {
  const max = Math.max(1, ...days.map((d) => d.events));
  const total = days.reduce((n, d) => n + d.events, 0);
  return (
    <span className="inline-flex items-end gap-[3px]" role="img" aria-label={`${total} events in the last ${days.length} days`} data-testid="activity-bars">
      {days.map((d) => (
        <i
          key={d.date}
          title={`${d.date} · ${d.events} ${d.events === 1 ? "event" : "events"}`}
          className="block rounded-[1px]"
          style={{
            width: barWidth,
            height: d.events > 0 ? Math.max(4, (d.events / max) * height) : 3,
            background: d.events > 0 ? LEGEND.run.dot : "var(--paper-300)",
          }}
        />
      ))}
    </span>
  );
}


export function moduleWaitingView(w: ModuleWaitingOn): WaitingOnView {
  const v = issueWaitingView(w);
  return {
    ...v,
    act: w.issueKey && w.kind !== "issue" ? `${w.issueKey} · ${w.act}` : w.act,
    rule: w.issueKey ? `${w.issueKey}: ${w.rule}` : w.rule,
  };
}

const BANNER: Record<ModuleAttentionGroup, BannerTone> = { needs_you: "you", moving: "agent", stuck: "blocked", quiet: "calm" };
const BANNER_HEAD: Record<ModuleAttentionGroup, string> = {
  needs_you: "Waiting on you:",
  moving: "Moving:",
  stuck: "Stuck:",
  quiet: "Quiet:",
};

function bannerText(group: ModuleAttentionGroup, w: ModuleWaitingOn): string {
  const tail = w.act ? ` · ${w.act}` : "";
  if (group === "needs_you" || group === "quiet") return w.act;
  if (group === "stuck" && w.kind === "issue") return `waits on ${w.who}${tail}`;
  return `${w.who}${tail}`;
}

/** The one line whom the module waits on, for the issue that leads its group; the rule rides the tooltip. */
export function ModuleBanner({ standing, slug, className }: { standing: ModuleStanding; slug: string; className?: string }) {
  const linked = standing.attentionGroup !== "needs_you";
  const w = standing.waitingOn;
  const lead = w.issueKey ? (
    linked ? (
    <Link href={issueHref(slug, w.issueKey)} className="font-mono text-12 font-semibold text-link hover:underline">
      {w.issueKey}
    </Link>
    ) : (
      <span className="font-mono text-12 font-semibold">{w.issueKey}</span>
    )
  ) : null;
  const act = bannerText(standing.attentionGroup, w);
  return (
    <WaitBanner
      tone={BANNER[standing.attentionGroup]}
      head={BANNER_HEAD[standing.attentionGroup]}
      body={
        <>
          {lead} {act}
        </>
      }
      rule={w.rule}
      className={className}
      testId="module-banner"
    />
  );
}

/** The one primary act of a module that waits on you: open the issue that leads it. */
export function ModuleAction({ standing, slug }: { standing: ModuleStanding; slug: string }) {
  const router = useRouter();
  const key = standing.attentionGroup === "needs_you" ? standing.waitingOn.issueKey : null;
  if (!key) return null;
  return (
    <Button type="button" variant="primary" size="sm" onClick={() => router.push(issueHref(slug, key))} data-testid="module-action">
      Open {key}
    </Button>
  );
}
