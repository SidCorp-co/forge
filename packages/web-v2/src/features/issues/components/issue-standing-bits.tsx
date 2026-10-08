"use client";

// What an issue's standing (core `issues/standing.ts`) says, put into the shared design pieces: the
// list row, whose turn as the shared WaitingOn and banner, the step bar, the criteria bar, and the
// facts the peek and the full page's rail show. Nothing here decides whose turn it is.

import type { Forecast } from "@forge/contracts/forecast";
import type { IssueStanding, IssueStandingRow } from "@forge/contracts/issue-standing";
import { WORK_STEPS } from "@forge/contracts/issue-vocabulary";
import Link from "next/link";
import { type ReactNode, useMemo } from "react";
import {
  ActorChip,
  type BannerTone,
  CoverageBar,
  Fact,
  FactsEmpty,
  FactsGroup,
  type ListRowView,
  MarkStrip,
  type MarkView,
  StatusBadge,
  statusReading,
  StepBar,
  ToneBadge,
  WaitBanner,
  WaitingOn,
} from "@/design";
import { EtaCell, EtaInline } from "@/features/forecast/components/eta-cell";
import { type Eta, type EtaClock, etaOfForecast } from "@/features/forecast/eta";
import { ETA_COPY } from "@/lib/i18n/eta-copy";
import { feedbackHref } from "@/lib/routes/feedback";
import { requirementHref } from "@/lib/routes/requirements";
import { useCopy, useInterfaceLanguage, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { said, saidView } from "@/lib/i18n/said";
import { issueHref } from "@/lib/routes/issues";
import { Written } from "@/lib/i18n/written";

const sentenceStart = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const issueBadge = (r: Pick<IssueStandingRow, "status" | "standing">) => (
  <StatusBadge family="issue" value={r.status} step={r.standing.step} tone={r.standing.tone} />
);

/** The words a list row is drawn in: the chrome reader and the date and time formatter of the interface language. */
export interface RowWords {
  t: Copy;
  time: ReturnType<typeof useTimeFormat>;
}

/** The row words of the interface language, for `issueRowView`. */
export function useRowWords(): RowWords {
  const t = useCopy();
  const time = useTimeFormat();
  return useMemo(() => ({ t, time }), [t, time]);
}

/** The secondary line: module, the requirement and its criteria, a high priority, where it came from, criteria passing. */
function factsLine(r: IssueStandingRow, t: Copy): string[] {
  const s = r.standing;
  const parts: string[] = [];
  if (s.module) parts.push(s.module.path);
  if (s.requirement) parts.push(`${s.requirement.key}${s.requirement.criteria.length ? ` ${s.requirement.criteria.join(", ")}` : ""}`);
  if (r.priority === "high" || r.priority === "critical") parts.push(r.priority === "critical" ? t("issues.facts.critical") : t("issues.facts.high"));
  if (s.feedback[0]) parts.push(t("issues.facts.from", { key: s.feedback[0] }));
  if (s.criteria.total > 0) parts.push(t("issues.facts.passing", { passing: s.criteria.passing, total: s.criteria.total }));
  return parts;
}

/** An issue's ETA from the project forecast; null while the forecast has not answered for it. */
export const issueEta = (forecast: Forecast | undefined, clock: EtaClock): Eta | null => (forecast ? etaOfForecast(forecast, clock) : null);

export const issueRowView =
  (slug: string, { t, time }: RowWords, eta?: { of: (key: string) => Eta | null; clock: EtaClock }) =>
  (r: IssueStandingRow): ListRowView => ({
    key: r.key,
    href: issueHref(slug, r.key),
    title: <Written text={r.title} lang={r.writtenLang} />,
    facts: factsLine(r, t),
    ...(eta ? { eta: <EtaCell eta={eta.of(r.key)} clock={eta.clock} /> } : {}),
    state: issueBadge(r),
    waitingOn: <WaitingOn w={r.standing.waitingOn} />,
    owner: r.standing.owner ? (
      <ActorChip name={r.standing.owner.name ?? t("issues.facts.unknown")} kind={r.standing.owner.kind} size={20} />
    ) : (
      <span className="text-subtle">{t("issues.facts.noOwner")}</span>
    ),
    age: { text: time.age(r.standing.touchedAt), title: t("needs.lastActivity", { at: time.dateTime(r.standing.touchedAt) }) },
    dim: r.standing.attentionGroup === "done",
  });

const BANNER: Record<IssueStanding["attentionGroup"], BannerTone> = {
  needs_you: "you",
  moving: "agent",
  stuck: "blocked",
  queued: "calm",
  paused: "calm",
  done: "calm",
};

/** The peek's one line: whom the issue waits on and for what, the rule on hover. */
export function IssueBanner({ standing, className }: { standing: IssueStanding; className?: string }) {
  const t = useCopy();
  const w = saidView(standing.waitingOn, useInterfaceLanguage());
  const g = standing.attentionGroup;
  return (
    <WaitBanner
      tone={BANNER[g]}
      head={g === "done" ? `${t("issues.attention.done")}.` : g === "stuck" ? t("issues.banner.stuck") : t("issues.banner.waitingOn", { who: w.kind === "you" ? t("issues.banner.you") : w.who })}
      body={g === "done" ? t("issues.banner.nothingOwed") : g === "stuck" ? `${w.who}${w.act ? ` · ${w.act}` : ""}` : w.act}
      rule={w.rule}
      className={className}
      testId="issue-banner"
    />
  );
}

/** Triage → … → Release with the current step lit; an issue past release is all done. */
function IssueSteps({ standing }: { standing: IssueStanding }) {
  const t = useCopy();
  const L = useLabel();
  const time = useTimeFormat();
  const over = standing.state === "awaiting_release" || standing.state === "closed";
  const at = standing.step ? WORK_STEPS.indexOf(standing.step) : -1;
  if (!over && at < 0) return null;
  return (
    <StepBar
      steps={WORK_STEPS.map((step, i) => ({
        key: step,
        label: L("workStep", step),
        state: over || i < at ? "done" : i === at ? "now" : "next",
        tone: standing.tone === "you" ? "you" : "run",
      }))}
      caption={
        !over && standing.stepStartedAt ? (
          <span title={time.dateTime(standing.stepStartedAt)}>
            {t("issues.steps.since", { step: L("workStep", standing.step ?? ""), at: time.relative(standing.stepStartedAt) })}
          </span>
        ) : undefined
      }
    />
  );
}

/** One mark per step and per criterion, the peek's at-a-glance strip: "Steps ▮▮▮▯ Test · Criteria ▮▮▯▯ 2 of 4 pass". */
export function IssueStrip({ standing }: { standing: IssueStanding }) {
  const t = useCopy();
  const L = useLabel();
  const over = standing.state === "awaiting_release" || standing.state === "closed";
  const at = standing.step ? WORK_STEPS.indexOf(standing.step) : -1;
  const c = standing.criteria;
  const unjudged = Math.max(0, c.total - c.passing - c.failing - c.skipped);
  const crit: MarkView[] = [
    ...Array.from({ length: c.passing }, (_, i) => ({ key: `p${i}`, label: t("issues.crit.passing"), tone: "ready" as const })),
    ...Array.from({ length: c.failing }, (_, i) => ({ key: `f${i}`, label: t("issues.crit.failing"), tone: "err" as const })),
    ...Array.from({ length: c.skipped }, (_, i) => ({ key: `s${i}`, label: t("issues.crit.skipped"), tone: "neutral" as const })),
    ...Array.from({ length: unjudged }, (_, i) => ({ key: `u${i}`, label: t("issues.crit.unjudged") })),
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-12 text-muted" data-testid="issue-strip">
      {over || at >= 0 ? (
        <span className="inline-flex items-center gap-2">
          {t("issues.steps.title")}
          <MarkStrip
            size="sm"
            marks={WORK_STEPS.map((step, i) => ({
              key: step,
              label: over || i < at ? t("common.stepDone", { label: L("workStep", step) }) : i === at ? t("common.stepNow", { label: L("workStep", step) }) : t("common.stepNext", { label: L("workStep", step) }),
              fill: over || i < at ? "var(--ink-600)" : i === at ? undefined : "var(--paper-300)",
              tone: i === at && !over ? (standing.tone === "you" ? "you" : "run") : undefined,
            }))}
          />
          <span className="text-fg">{over ? t("common.statusKey.done") : L("workStep", standing.step ?? "")}</span>
        </span>
      ) : null}
      <span className="inline-flex items-center gap-2">
        {t("issues.tab.criteria")}
        {c.total ? (
          <>
            <MarkStrip size="sm" marks={crit} />
            <span className="text-fg">{t("issues.crit.ofPass", { passing: c.passing, total: c.total })}</span>
          </>
        ) : (
          <span className="text-subtle">{t("issues.steps.none")}</span>
        )}
      </span>
    </div>
  );
}

/** The peek's facts, each once and each beside where it comes from: whom it waits on, the
 *  requirement it serves, its module, its branch, its owner. State and whose turn are the head's
 *  and the banner's, so they are not repeated here. */
export function IssuePeekFacts({
  row,
  slug,
  forecast,
  clock,
}: {
  row: IssueStandingRow;
  slug: string;
  forecast?: Forecast | undefined;
  clock: EtaClock;
}) {
  const s = row.standing;
  const t = useCopy();
  const language = useInterfaceLanguage();
  const sub = (text: ReactNode) => <span className="mt-0.5 block text-12 text-subtle">{text}</span>;
  return (
    <div className="divide-y divide-line-subtle" data-testid="issue-peek-facts">
      {s.attentionGroup !== "done" ? (
        <Fact label={t("issues.facts.waitsOn")}>
          <span className="min-w-0">
            <WaitingOn w={s.waitingOn} />
            {s.waitingOn.rule ? sub(sentenceStart(said(s.waitingOn.says.rule, language))) : null}
          </span>
        </Fact>
      ) : null}
      {forecast && forecast.kind !== "landed" && forecast.kind !== "ended" ? (
        <Fact label={ETA_COPY[clock.lang].header} testId="issue-peek-forecast">
          <EtaInline eta={etaOfForecast(forecast, clock)} clock={clock} />
        </Fact>
      ) : null}
      {s.requirement ? (
        <Fact label={t("issues.facts.requirement")}>
          <span className="min-w-0">
            <Link href={requirementHref(slug, s.requirement.key)} className="font-mono text-12 font-semibold text-link hover:underline">
              {s.requirement.key}
            </Link>
            {s.requirement.criteria.length ? <span className="ml-1.5 font-mono text-12">{s.requirement.criteria.join(", ")}</span> : null}
            {s.requirement.changedSincePlan ? (
              <span className="ml-1.5 text-12-5" data-testid="changed-since-plan">
                · {t("issues.facts.plannedOnShort", { planned: s.requirement.plannedRevision ?? "", now: s.requirement.currentRevision ?? "" })}
              </span>
            ) : null}
            {sub(s.requirement.title)}
          </span>
        </Fact>
      ) : null}
      {s.module ? (
        <Fact label={t("issues.field.module")}>
          <span className="min-w-0">
            <span className="font-mono text-12">{s.module.path}</span>
            {sub(s.module.name)}
          </span>
        </Fact>
      ) : null}
      {s.branch ? (
        <Fact label={t("issues.rail.branch")}>
          <span className="min-w-0">
            <span className="font-mono text-12">
              {s.branch}
              {s.headSha ? ` · ${s.headSha.slice(0, 7)}` : ""}
            </span>
            {s.lease?.holder ? sub(`${s.lease.holder} · ${t("issues.facts.leaseWord")} ${t(`issues.lease.${s.lease.verdict}`).toLowerCase()}`) : null}
          </span>
        </Fact>
      ) : null}
      <Fact label={t("issues.facts.owner")}>
        {s.owner ? <ActorChip name={s.owner.name ?? t("issues.facts.unknown")} kind={s.owner.kind} /> : <span className="text-subtle">{t("issues.facts.noOwner")}</span>}
      </Fact>
      {s.blocks.length ? (
        <Fact label={t("issues.rail.blocks")}>
          <span className="flex min-w-0 flex-wrap gap-x-2">
            {s.blocks.map((b) => (
              <Link key={b.key} href={issueHref(slug, b.key)} className="font-mono text-12 font-semibold text-link hover:underline" title={b.title}>
                {b.key}
              </Link>
            ))}
          </span>
        </Fact>
      ) : null}
      {s.feedback.length ? (
        <Fact label={t("issues.facts.fromLabel")}>
          <span className="flex min-w-0 flex-wrap gap-x-2">
            {s.feedback.map((k) => (
              <Link key={k} href={feedbackHref(slug, k)} className="font-mono text-12 font-semibold text-link hover:underline">
                {k}
              </Link>
            ))}
          </span>
        </Fact>
      ) : null}
    </div>
  );
}

export function IssueStandingFacts({ row, slug }: { row: IssueStandingRow; slug: string }) {
  const s = row.standing;
  const c = s.criteria;
  const unjudged = Math.max(0, c.total - c.passing - c.failing - c.skipped);
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <div data-testid="issue-standing-facts">
      <FactsGroup title={t("issues.facts.whereItStands")}>
        <Fact label={t("issues.facts.owner")}>
          {s.owner ? <ActorChip name={s.owner.name ?? t("issues.facts.unknown")} kind={s.owner.kind} /> : <span className="text-subtle">{t("issues.facts.noOwner")}</span>}
        </Fact>
        {s.lease ? (
          <Fact label={t("issues.facts.lease")}>
            <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
              <ToneBadge
                tone={statusReading("lease", s.lease.verdict).tone}
                label={t(`issues.lease.${s.lease.verdict}`)}
                title={s.lease.verdict}
                value={s.lease.verdict}
              />
              {s.lease.holder ? <span className="truncate font-mono text-12">{s.lease.holder}</span> : null}
            </span>
          </Fact>
        ) : null}
        <Fact label={t("issues.facts.lastActivity")}>
          <span title={time.dateTime(s.touchedAt)}>{time.relative(s.touchedAt)}</span>
        </Fact>
        <div className="pt-2.5">
          <IssueSteps standing={s} />
        </div>
      </FactsGroup>

      <FactsGroup title={t("issues.tab.criteria")} count={c.total ? t("issues.crit.passingOf", { passing: c.passing, total: c.total }) : undefined} testId="facts-criteria">
        {c.total === 0 ? (
          <FactsEmpty>{t("issues.criteria.empty")}</FactsEmpty>
        ) : (
          <CoverageBar
            segments={[
              { key: "pass", label: t("issues.crit.passing"), count: c.passing, tone: "ready" },
              { key: "fail", label: t("issues.crit.failing"), count: c.failing, tone: "err" },
              { key: "skipped", label: t("issues.crit.skipped"), count: c.skipped, tone: "neutral" },
              { key: "unjudged", label: t("issues.crit.unjudged"), count: unjudged },
            ]}
          />
        )}
      </FactsGroup>

      {s.requirement ? (
        <FactsGroup title={t("issues.facts.requirement")} testId="facts-requirement">
          <div className="flex min-w-0 items-center gap-1.5 text-13">
            <Link href={requirementHref(slug, s.requirement.key)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
              {s.requirement.key}
            </Link>
            <span className="min-w-0 flex-1 truncate" title={s.requirement.title}>
              {s.requirement.title}
            </span>
          </div>
          {s.requirement.criteria.length ? <p className="mt-1 font-mono text-12 text-muted">{t("issues.facts.tracesTo", { codes: s.requirement.criteria.join(", ") })}</p> : null}
          {s.requirement.changedSincePlan ? (
            <p className="mt-1 text-12-5" data-testid="changed-since-plan">
              {t("issues.facts.plannedOn", { planned: s.requirement.plannedRevision ?? "", now: s.requirement.currentRevision ?? "" })}
            </p>
          ) : null}
        </FactsGroup>
      ) : null}

      {s.feedback.length ? (
        <FactsGroup title={t("issues.facts.feedback")} count={t("issues.facts.reports", { n: s.feedback.length })}>
          <div className="flex flex-wrap gap-2">
            {s.feedback.map((k) => (
              <Link key={k} href={feedbackHref(slug, k)} className="font-mono text-12 font-semibold text-link hover:underline">
                {k}
              </Link>
            ))}
          </div>
        </FactsGroup>
      ) : null}
    </div>
  );
}
