"use client";

// The status report (JU-4): the project status read as a dated report a person prints, or copies as
// Markdown to send. Flat: one heading per section over hairline lists, each section dated by the
// moment its own read answered. Every figure is core's; this page only lays it out.

import type { ProjectStatus, RoadmapItem } from "@forge/contracts/project-status";
import { ROADMAP_HORIZONS } from "@forge/contracts/project-status";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, MonoTag, SegmentedControl, StatusBadge, ViewHeading, WaitingOn } from "@/design";
import { IssueProgressText } from "@/features/forecast/components/issue-progress";
import { type EtaClock, etaInline, etaOfDelivery } from "@/features/forecast/eta";
import { spanText } from "@/features/forecast/text";
import { formatDateTime } from "@/lib/i18n/format";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { needsYouHref, needsYouKeyLabel } from "@/features/needs-you/routes";
import { verifiedSentence } from "@/features/releases/verified";
import { statusMarkdown } from "../report-markdown";

export const STATUS_WINDOWS = ["7", "14", "30"] as const;
export type StatusWindow = (typeof STATUS_WINDOWS)[number];

const ROW = "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line-subtle py-2 text-13";
const LIST = "border-t border-line-subtle";
const KEY_LINK = "font-mono text-12 text-link hover:underline";

function Section({ title, asOf, clock, children, testId }: { title: string; asOf: string; clock: EtaClock; children: React.ReactNode; testId: string }) {
  const t = useCopy();
  return (
    <section aria-label={title} data-testid={testId} className="break-inside-avoid">
      <ViewHeading hint={t("status.readAt", { at: formatDateTime(asOf, clock.lang, clock.timeZone) })}>{title}</ViewHeading>
      {children}
    </section>
  );
}

const Quiet = ({ children }: { children: React.ReactNode }) => <p className="text-13 text-muted">{children}</p>;

function eta(d: RoadmapItem["delivery"], clock: EtaClock) {
  return d ? <span className="text-12-5 text-muted">{etaInline(etaOfDelivery(d, clock), clock)}</span> : null;
}

/** Now, Next and Later from core's roadmap read; `rules` says under each how it is filled and ordered. */
export function Roadmap({ s, slug, clock, rules = false }: { s: Pick<ProjectStatus, "roadmap">; slug: string; clock: EtaClock; rules?: boolean }) {
  const t = useCopy();
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-3">
      {ROADMAP_HORIZONS.map((h) => (
        <div key={h} data-testid="status-horizon" data-horizon={h}>
          <h3 className="mb-1.5 text-13 font-semibold text-fg">{t(`status.horizon.${h}`)}</h3>
          {rules ? <p className="mb-2 text-12 text-muted" data-testid="roadmap-rule">{t(`roadmap.rule.${h}`)}</p> : null}
          {s.roadmap[h].length === 0 ? (
            <Quiet>{t("status.horizonEmpty")}</Quiet>
          ) : (
            <ul className={LIST}>
              {s.roadmap[h].map((i) => (
                <li key={i.key} className={ROW}>
                  <Link href={requirementHref(slug, i.key)} className={KEY_LINK}>
                    {i.key}
                  </Link>
                  <span className="min-w-0 flex-1">{i.title}</span>
                  {eta(i.delivery, clock)}
                  {i.deferral ? (
                    <span className="w-full text-12-5 text-muted">
                      {i.deferral.targetPhase
                        ? t("status.deferredTo", { phase: i.deferral.targetPhase, reason: i.deferral.reason })
                        : t("status.deferred", { reason: i.deferral.reason })}
                    </span>
                  ) : null}
                  {i.state === "draft" ? <span className="w-full text-12-5 text-muted">{t("status.notAgreed")}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

export interface StatusReportProps {
  s: ProjectStatus;
  slug: string;
  clock: EtaClock;
  window: StatusWindow;
  onWindow: (w: StatusWindow) => void;
}

export function StatusReport({ s, slug, clock, window, onWindow }: StatusReportProps) {
  const t = useCopy();
  const label = useLabel();
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const markdown = useMemo(() => statusMarkdown(s, { t, label, clock }), [s, t, label, clock]);
  const when = (iso: string) => formatDateTime(iso, clock.lang, clock.timeZone);
  const copy = () => {
    const done = navigator.clipboard?.writeText(markdown);
    if (!done) return setCopied("failed");
    done.then(
      () => setCopied("done"),
      () => setCopied("failed"),
    );
  };
  return (
    <article data-testid="status-report" className="grid gap-9">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="fg-h2 min-w-0 flex-1">
            {s.name} — {t("status.title")}
          </h1>
          <div className="flex items-center gap-2 print:hidden">
            <Button onClick={copy} data-testid="status-copy">
              {copied === "done" ? t("status.copied") : t("status.copy")}
            </Button>
            <Button onClick={() => globalThis.print?.()} data-testid="status-print">
              {t("status.print")}
            </Button>
          </div>
        </div>
        <p className="text-13 text-muted" data-testid="status-as-of">
          {t("status.asOf", { at: when(s.asOf) })} · {t("status.window", { days: s.days })}
        </p>
        <div className="print:hidden">
          <SegmentedControl
            value={window}
            onChange={onWindow}
            options={STATUS_WINDOWS.map((w) => ({ value: w, label: t("status.days", { days: w }) }))}
          />
        </div>
        {copied === "failed" ? (
          <p role="alert" className="text-13 text-danger">
            {t("status.copyFailed")}
          </p>
        ) : null}
      </header>

      <Section title={t("status.shipped")} asOf={s.shipped.asOf} clock={clock} testId="status-shipped">
        {s.shipped.releases.length === 0 ? (
          <Quiet>{t("status.shippedNone", { days: s.days })}</Quiet>
        ) : (
          <ul className={LIST}>
            {s.shipped.releases.map((r) => (
              <li key={r.version} className={ROW} data-testid="status-shipped-release">
                <Link href={releaseHref(slug, r.version)} className="font-mono text-13 font-semibold text-link hover:underline">
                  {r.version}
                </Link>
                <span className="text-muted">{when(r.releasedAt)}</span>
                <span className="text-muted">{t("dash.shippedIssues", { n: r.issueCount })}</span>
                <span className="min-w-0 flex-1 text-muted">{verifiedSentence(r.verified, t)}</span>
                {r.headline ? <span className="w-full">{r.headline}</span> : null}
              </li>
            ))}
            {s.shipped.releaseCount > s.shipped.releases.length ? (
              <li className={`${ROW} text-muted`}>{t("status.shippedMore", { n: s.shipped.releaseCount - s.shipped.releases.length })}</li>
            ) : null}
          </ul>
        )}
        {s.shipped.requirementsShipped.length > 0 ? (
          <p className="mt-3 text-13">
            <span className="text-muted">{t("status.requirementsShipped")}: </span>
            {s.shipped.requirementsShipped.map((r, i) => (
              <span key={r.key}>
                {i > 0 ? ", " : ""}
                <Link href={requirementHref(slug, r.key)} className={KEY_LINK} title={r.title}>
                  {r.key}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
      </Section>

      <Section title={t("status.inFlight")} asOf={s.inFlight.asOf} clock={clock} testId="status-in-flight">
        <p className="text-13">
          <span className="font-semibold">{t("status.openIssues", { n: s.inFlight.open })}</span>
          {s.inFlight.byStatus.length > 0 ? <span className="text-muted"> · {s.inFlight.byStatus.map((b) => `${label("issueStatus", b.status)} ${b.count}`).join(" · ")}</span> : null}
        </p>
        {s.inFlight.truncated ? <Quiet>{t("status.truncated")}</Quiet> : null}
        <h3 className="mt-3 mb-1.5 text-13 font-semibold">{t("status.running")}</h3>
        {s.inFlight.running.length === 0 ? (
          <Quiet>{t("status.runningNone")}</Quiet>
        ) : (
          <ul className={LIST}>
            {s.inFlight.running.map((i) => (
              <li key={i.key} className={ROW}>
                <Link href={issueHref(slug, i.key)} className={KEY_LINK}>
                  {i.key}
                </Link>
                <span className="min-w-0 flex-1">{i.title}</span>
                <StatusBadge family="issue" value={i.status} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("status.waits")} asOf={s.waits.asOf} clock={clock} testId="status-waits">
        {s.waits.people.length === 0 ? (
          <Quiet>{t("status.waitsNone")}</Quiet>
        ) : (
          <ul className={LIST}>
            {s.waits.people.map((x) => (
              <li key={`${x.area}:${x.key}`} className={ROW}>
                <Link href={needsYouHref(slug, x)} className={KEY_LINK}>
                  {needsYouKeyLabel(x, (a) => label("needsYouArea", a))}
                </Link>
                <span className="min-w-0 flex-1">{x.title}</span>
                <WaitingOn w={x.waitingOn} />
              </li>
            ))}
            {s.waits.peopleCount > s.waits.people.length ? (
              <li className={`${ROW} text-muted`}>{t("status.waitsMore", { n: s.waits.peopleCount - s.waits.people.length })}</li>
            ) : null}
          </ul>
        )}
      </Section>

      <Section title={t("status.requirements")} asOf={s.requirements.asOf} clock={clock} testId="status-requirements">
        <p className="mb-2 text-13 font-semibold" data-testid="status-criteria-proven">
          {t("status.criteriaProven", { proven: s.requirements.proven, total: s.requirements.total })}
        </p>
        {s.requirements.items.length === 0 ? (
          <Quiet>{t("status.requirementsNone")}</Quiet>
        ) : (
          <ul className={LIST}>
            {s.requirements.items.map((r) => (
              <li key={r.key} className={ROW}>
                <Link href={requirementHref(slug, r.key)} className={KEY_LINK}>
                  {r.key}
                </Link>
                <span className="min-w-0 flex-1">{r.title}</span>
                <StatusBadge family="requirement" value={r.state} />
                <span className="text-12-5 text-muted">{t("status.criteriaProven", { proven: r.criteria.proven, total: r.criteria.total })}</span>
                <IssueProgressText progress={r.progress} className="text-12-5 text-muted" />
                {eta(r.delivery, clock)}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("status.nextRelease")} asOf={s.nextRelease.asOf} clock={clock} testId="status-next-release">
        {s.nextRelease.version === null ? (
          <Quiet>{t("status.nextReleaseNone")}</Quiet>
        ) : (
          <p className="flex flex-wrap items-baseline gap-x-3 text-13">
            <Link href={releaseHref(slug, s.nextRelease.version)} className="font-mono text-13 font-semibold text-link hover:underline">
              {s.nextRelease.version}
            </Link>
            {s.nextRelease.state && s.nextRelease.state !== "draft" ? <span className="text-muted">{label("releaseState", s.nextRelease.state)}</span> : null}
            <IssueProgressText progress={s.nextRelease.progress} className="text-muted" />
            {s.nextRelease.forecast?.delivery ? eta(s.nextRelease.forecast.delivery, clock) : null}
            {s.nextRelease.turn ? <WaitingOn w={{ kind: "person", who: s.nextRelease.turn.who, act: s.nextRelease.turn.act, says: s.nextRelease.turn.says }} /> : null}
            {s.nextRelease.behind ? (
              <span className="text-muted" data-testid="status-next-behind">
                {t("status.behind", { version: s.nextRelease.behind.version, n: s.nextRelease.behind.issueCount })}
              </span>
            ) : null}
          </p>
        )}
      </Section>

      <Section title={t("status.late")} asOf={s.late.asOf} clock={clock} testId="status-late">
        {s.late.items.length === 0 ? (
          <Quiet>{t("status.lateNone")}</Quiet>
        ) : (
          <ul className={LIST}>
            {s.late.items.map((l) => (
              <li key={`${l.kind}:${l.key}`} className={ROW}>
                <MonoTag>{l.key}</MonoTag>
                <span className="min-w-0 flex-1">{l.title}</span>
                <span className="text-12-5 text-danger">{t(`status.late.${l.late.reason}`, { by: spanText(l.late.byMinutes, clock.lang) })}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("status.roadmap")} asOf={s.roadmap.asOf} clock={clock} testId="status-roadmap">
        <Roadmap s={s} slug={slug} clock={clock} />
      </Section>

      <p className="text-12-5 text-muted">{t("status.forecastNote")}</p>
    </article>
  );
}
