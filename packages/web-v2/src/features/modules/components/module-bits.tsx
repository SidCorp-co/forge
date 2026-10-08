"use client";

import { ISSUE_ATTENTION_LABELS } from "@forge/contracts/issue-standing";
import { MODULE_ATTENTION_LABELS, MODULE_OPEN_KINDS } from "@forge/contracts/modules";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type BannerTone, Button, type CoverageSegment, LEGEND, ToneBadge, WaitBanner, type WaitingOnView } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { copyOr, productCopy } from "@/lib/i18n/product-copy";
import { saidView } from "@/lib/i18n/said";
import { issueHref } from "@/lib/routes/issues";
import { formatStamp } from "@/lib/utils/format";
import type { ModuleAttentionGroup, ModuleActivityDay, ModuleLanding, ModuleStanding } from "../types";

const DAY_MS = 86_400_000;

export function AttentionBadge({ group }: { group: ModuleAttentionGroup }) {
  const language = useInterfaceLanguage();
  const m = MODULE_ATTENTION_LABELS[group];
  const label = copyOr(language, `modules.attention.${group}`, m.label);
  const hint = copyOr(language, `modules.attention.${group}.hint`, m.hint ?? "");
  return <ToneBadge tone={m.tone} label={label} value={group} pulse={group === "moving"} title={`${label} · ${hint}`} />;
}

/** An open-issue kind's words in `language`, from the issue list's own. */
const kindLabel = (k: (typeof MODULE_OPEN_KINDS)[number], language: string) => copyOr(language, `issues.attention.${k}`, ISSUE_ATTENTION_LABELS[k].label);

export const openSegments = (s: ModuleStanding, language = "en"): CoverageSegment[] =>
  MODULE_OPEN_KINDS.map((k) => ({
    key: k,
    label: kindLabel(k, language),
    count: s.openByKind[k],
    tone: ISSUE_ATTENTION_LABELS[k].tone,
    hint: copyOr(language, `issues.attention.${k}.hint`, ISSUE_ATTENTION_LABELS[k].hint ?? "") || undefined,
  }));

function landingAge(l: ModuleLanding, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(l.landedAt).getTime()) / DAY_MS));
}

function RecencyDot({ landing }: { landing: ModuleLanding | null }) {
  const t = useCopy();
  const days = landing ? landingAge(landing) : null;
  const colour = days === null ? "var(--paper-300)" : days <= 2 ? LEGEND.ready.dot : days <= 7 ? "var(--ink-400)" : "var(--paper-400)";
  const title = landing ? t("modules.lastLanding", { key: landing.issueKey, when: formatStamp(landing.landedAt), d: days ?? 0 }) : t("modules.nothingLanded");
  return <span role="img" aria-label={title} title={title} className="size-2 flex-none rounded-full" style={{ background: colour }} data-testid="recency-dot" />;
}

/** Open issues by state on one scale across the list, the dot ahead of it the recency of the last landing. */
export function OpenBar({ standing, max }: { standing: ModuleStanding; max: number }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const parts = MODULE_OPEN_KINDS.filter((k) => standing.openByKind[k] > 0);
  const text = parts.length ? parts.map((k) => `${kindLabel(k, language)} ${standing.openByKind[k]}`).join(" · ") : t("modules.nothingOpenShort");
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
  const t = useCopy();
  const max = Math.max(1, ...days.map((d) => d.events));
  const total = days.reduce((n, d) => n + d.events, 0);
  return (
    <span className="inline-flex items-end gap-[3px]" role="img" aria-label={t("modules.activity.aria", { n: total, days: days.length })} data-testid="activity-bars">
      {days.map((d) => (
        <i
          key={d.date}
          title={`${d.date} · ${t(d.events === 1 ? "modules.activity.eventOne" : "modules.activity.eventMany", { n: d.events })}`}
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


/** The module's wait as the cell draws it, read from what core said, its lead issue before the act. */
export function moduleWaitingView(s: ModuleStanding, language = "en"): WaitingOnView {
  const w = saidView(s.waitingOn, language);
  const lead = s.leadIssue;
  return {
    ...w,
    act: lead && w.kind !== "issue" ? `${lead} · ${w.act}` : w.act,
    rule: lead ? `${lead}: ${w.rule}` : w.rule,
  };
}

const BANNER: Record<ModuleAttentionGroup, BannerTone> = { needs_you: "you", moving: "agent", stuck: "blocked", quiet: "calm" };
function bannerText(group: ModuleAttentionGroup, w: { kind: string; who: string; act: string }, language: string): string {
  const tail = w.act ? ` · ${w.act}` : "";
  if (group === "needs_you" || group === "quiet") return w.act;
  if (group === "stuck" && w.kind === "issue") return `${productCopy(language)("modules.banner.waitsOn", { who: w.who })}${tail}`;
  return `${w.who}${tail}`;
}

/** The one line whom the module waits on, for the issue that leads its group; the rule rides the tooltip. */
export function ModuleBanner({ standing, slug, className }: { standing: ModuleStanding; slug: string; className?: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const linked = standing.attentionGroup !== "needs_you";
  const w = saidView(standing.waitingOn, language);
  const key = standing.leadIssue;
  const lead = key ? (
    linked ? (
    <Link href={issueHref(slug, key)} className="font-mono text-12 font-semibold text-link hover:underline">
      {key}
    </Link>
    ) : (
      <span className="font-mono text-12 font-semibold">{key}</span>
    )
  ) : null;
  const act = bannerText(standing.attentionGroup, w, language);
  return (
    <WaitBanner
      tone={BANNER[standing.attentionGroup]}
      head={t(`modules.banner.${standing.attentionGroup}`)}
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
  const t = useCopy();
  const key = standing.attentionGroup === "needs_you" ? standing.leadIssue : null;
  if (!key) return null;
  return (
    <Button type="button" variant="primary" size="sm" onClick={() => router.push(issueHref(slug, key))} data-testid="module-action">
      {t("modules.action.open", { key })}
    </Button>
  );
}
