// What a project's master is doing, as one row and its peek read it (ISS-951, MK-9): its pane's badge
// (Busy · Subagents · Idle · Dialog · Silent · No master) from the state core derived and the pane's
// own hooks, how long since its box last spoke (red past the silence limit), and what it does by name.
// A pane core holds only as of the last pass (a box older than the beat) says so; it is never shown
// as live.

import type { OrgActivityMaster, OrgActivityProject } from "@forge/contracts/org-activity";
import { enumLabel, type LegendTone, ToneBadge } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";

export const PANE_KINDS = ["busy", "subagents", "dialog", "idle", "silent", "none"] as const;
export type PaneKind = (typeof PANE_KINDS)[number];

const PANE_TONE: Record<PaneKind, LegendTone> = { busy: "run", subagents: "run", dialog: "you", idle: "neutral", silent: "err", none: "neutral" };

const liveAt = (m: OrgActivityMaster, now: number) => m.pane !== null && now - Date.parse(m.pane.seenAt) <= m.silentAfterSeconds * 1000;

/** The pane's badge: core's state first, the pane's own hooks where they are live and say more. */
export function paneKind(m: OrgActivityMaster, now: number): PaneKind {
  if (m.state === "none") return "none";
  if (m.state === "silent") return "silent";
  if (m.state === "waiting_person") return "dialog";
  const doing = liveAt(m, now) ? m.pane?.doing : undefined;
  if (doing === "awaiting_permission") return "dialog";
  if (doing === "awaiting_children" || m.state === "runs_out") return "subagents";
  if (m.state === "in_pass" || m.state === "busy") return "busy";
  return "idle";
}

/** `12s ago`, `9 min ago`, `2 h ago`. */
export function agoText(t: Copy, at: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 60) return t("activity.ago.s", { n: s });
  if (s < 3600) return t("activity.ago.m", { n: Math.floor(s / 60) });
  return t("activity.ago.h", { n: Math.floor(s / 3600) });
}

/** The badge and the time since the box last spoke for the master. */
export function PaneMark({ master, now }: { master: OrgActivityMaster; now: number }) {
  const t = useCopy();
  const kind = paneKind(master, now);
  const asOfPass = master.pane?.source === "pass";
  const late = master.lastBeatAt !== null && now - Date.parse(master.lastBeatAt) > master.silentAfterSeconds * 1000;
  return (
    <span className="inline-flex min-w-0 items-center gap-2" data-testid="activity-pane" data-pane={kind}>
      <ToneBadge tone={PANE_TONE[kind]} label={t(`activity.pane.${kind}`)} title={asOfPass ? t("activity.asOfPass") : t(`activity.pane.${kind}`)} value={kind} />
      {master.lastBeatAt ? (
        <span className={cn("whitespace-nowrap font-mono text-11-5 tabular-nums", late ? "font-semibold text-danger" : "text-subtle")} data-testid="activity-ago" data-late={late || undefined}>
          {agoText(t, master.lastBeatAt, now)}
        </span>
      ) : null}
    </span>
  );
}

/** The open pass's verb and issue, or the issue of its newest run, quieter; a dash where neither stands. */
export function Doing({ master }: { master: OrgActivityMaster }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const d = master.doing;
  if (!d) return <span className="text-subtle">—</span>;
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5 truncate text-13" data-testid="activity-doing" title={d.kind === "run" ? t("activity.doing.run") : undefined}>
      {d.verb ? <span className="font-medium text-fg">{enumLabel("masterVerb", d.verb, language)}</span> : null}
      {d.issueKey ? <span className={cn("font-mono text-12", d.kind === "run" ? "text-subtle" : "text-muted")}>{d.issueKey}</span> : null}
    </span>
  );
}

/** Two labelled counts: what waits for a release, and the next release as shipped of total. */
export function ReleaseCounts({ row }: { row: OrgActivityProject }) {
  const t = useCopy();
  const parts: { label: string; value: string; testId: string }[] = [];
  if (row.awaitingRelease > 0) parts.push({ label: t("activity.release.toRelease"), value: String(row.awaitingRelease), testId: "activity-to-release" });
  if (row.releasePending) parts.push({ label: t("activity.release.next"), value: "…", testId: "activity-release" });
  else if (row.release) parts.push({ label: t("activity.release.next"), value: `${row.release.shipped}/${row.release.total}`, testId: "activity-release" });
  if (parts.length === 0) return <span className="text-subtle">—</span>;
  return (
    <span className="flex flex-col items-end gap-0.5">
      {parts.map((p) => (
        <span key={p.testId} className="inline-flex items-baseline gap-1.5" data-testid={p.testId} title={p.testId === "activity-release" ? (row.release?.title ?? undefined) : undefined}>
          <span className="text-11-5 text-subtle">{p.label}</span>
          <span className="font-mono text-12 font-semibold tabular-nums text-fg">{p.value}</span>
        </span>
      ))}
    </span>
  );
}
