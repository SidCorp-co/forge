// What a project's master is doing, as one row and its peek read it (ISS-951, MK-9): its pane's badge
// (Busy · Subagents · Idle · Dialog · Silent · No master) from the state core derived and the pane's
// own hooks, how long since its box last spoke (red past the silence limit), and what it does by name.
// A pane core holds only as of the last pass (a box older than the beat) says so; it is never shown
// as live.

import type { OrgActivityMaster } from "@forge/contracts/org-activity";
import { enumLabel, type LegendTone, ToneBadge } from "@/design";
import { useCopy, useCopyLocale, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";

export const PANE_KINDS = ["busy", "subagents", "dialog", "idle", "silent", "none"] as const;
export type PaneKind = (typeof PANE_KINDS)[number];

const PANE_TONE: Record<PaneKind, LegendTone> = { busy: "run", subagents: "run", dialog: "you", idle: "neutral", silent: "err", none: "neutral" };

/** Pane facts a box's beat sent within the silence limit: the only facts that say what a pane does now. */
export const paneIsLive = (m: OrgActivityMaster, now: number) => m.pane?.source === "beat" && now - Date.parse(m.pane.seenAt) <= m.silentAfterSeconds * 1000;

/**
 * The pane's badge, or null where nothing live says what the pane does: a box with no beat facts (none,
 * or only as of its last pass), or beat facts older than the silence limit, makes no Idle or Busy claim
 * (VISION: state-never-lies). A dialog it stands on, a silent box and no master are said whatever.
 */
export function paneKind(m: OrgActivityMaster, now: number): PaneKind | null {
  if (m.state === "none") return "none";
  if (m.state === "silent") return "silent";
  if (m.state === "waiting_person") return "dialog";
  if (!paneIsLive(m, now)) return null;
  const doing = m.pane?.doing;
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

/**
 * How fresh what the row says is: the age of the facts its badge was read from, red past the silence
 * limit; where no live facts stand, a muted "Last pass HH:MM" in the viewer's time ("In pass" while one
 * is open, "No pass" where none settled), never an age that reads fresh for an old fact.
 */
export function PaneMark({ master, now }: { master: OrgActivityMaster; now: number }) {
  const t = useCopy();
  const locale = useCopyLocale();
  const kind = paneKind(master, now);
  const clock = (at: string) => new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const factAt = master.state === "silent" ? master.lastBeatAt : master.pane?.source === "beat" ? master.pane.seenAt : null;
  const late = factAt !== null && now - Date.parse(factAt) > master.silentAfterSeconds * 1000;
  const lastPass =
    kind === null
      ? master.state === "in_pass" && master.since
        ? t("activity.inPass", { time: clock(master.since) })
        : master.lastPassEndedAt
          ? t("activity.lastPass", { time: clock(master.lastPassEndedAt) })
          : t("activity.noPass")
      : null;
  return (
    <span className="inline-flex min-w-0 flex-col items-end gap-0.5" data-testid="activity-pane" data-pane={kind ?? "pass"}>
      {kind ? <ToneBadge tone={PANE_TONE[kind]} label={t(`activity.pane.${kind}`)} title={t(`activity.pane.${kind}`)} value={kind} /> : null}
      {factAt && (kind !== null || late) && kind !== "none" ? (
        <span className={cn("whitespace-nowrap font-mono text-11-5 tabular-nums", late ? "font-semibold text-danger" : "text-subtle")} data-testid="activity-ago" data-late={late || undefined}>
          {agoText(t, factAt, now)}
        </span>
      ) : null}
      {lastPass && !late ? (
        <span className="whitespace-nowrap text-11-5 text-subtle" data-testid="activity-last-pass">
          {lastPass}
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
