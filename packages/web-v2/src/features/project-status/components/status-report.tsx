
// The status report (JU-4): the project status read as a dated report a person prints, or copies as
// Markdown to send. Flat: each part one line shut to its title, its count and a few words, dated by
// the moment its own read answered on that line's hover (ISS-903); what is stuck and what needs you
// stand open, and every part prints open. Copy and Print are the palette's (⌘K). Every figure is
// core's; this page only lays it out.

import type { ProjectStatus, RoadmapItem } from "@forge/contracts/project-status";
import { ROADMAP_HORIZONS } from "@forge/contracts/project-status";
import { Link } from "@/lib/navigation/router";
import { type ReactNode, useMemo, useState } from "react";
import { SegmentedControl, StatusBadge, usePageCommands, WaitingOn } from "@/design";
import { IssueProgressText } from "@/features/forecast";
import { type EtaClock, etaInline, etaOfDelivery } from "@/features/forecast";
import { honestyLine } from "@/features/forecast";
import { spanText } from "@/features/forecast";
import { formatDateTime } from "@/lib/i18n/format";
import { useCopy, useInterfaceLanguage, useLabel } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { needsYouHref, needsYouKeyLabel } from "@/features/needs-you";
import { verifiedSentence } from "@/features/releases";
import { personHeading, statusMarkdown, waitGroups } from "../report-markdown";
import { Written } from "@/lib/i18n/written";
import { ReportPart } from "./report-part";
import { NeedsYouPart, StuckPart } from "./status-lead";

export const STATUS_WINDOWS = ["7", "14", "30"] as const;
type StatusWindow = (typeof STATUS_WINDOWS)[number];

const ROW = "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line-subtle py-2 text-13";
const LIST = "border-t border-line-subtle";
/** A row leads with its title as the link; the key is the link's tooltip, never text on the face (ISS-1072). */
const TITLE_LINK = "min-w-0 flex-1 text-fg hover:text-link hover:underline";
/** A title named inline in a sentence, linked, its key the tooltip. */
const NAME_LINK = "text-link hover:underline";

const Quiet = ({ children }: { children: React.ReactNode }) => <p className="text-13 text-muted">{children}</p>;

function eta(d: RoadmapItem["delivery"], clock: EtaClock) {
  return d ? <span className="text-13 text-muted">{etaInline(etaOfDelivery(d, clock), clock)}</span> : null;
}

/** The forecast's move and why, its confidence and its release: core's, said in the reader's language. */
function Honesty({ d, moved, clock }: { d: RoadmapItem["delivery"]; moved: RoadmapItem["moved"]; clock: EtaClock }) {
  const t = useCopy();
  const line = honestyLine(d, moved, t, clock.lang);
  return line ? (
    <span className="w-full text-13 text-muted" data-testid="forecast-honesty">
      {line}
    </span>
  ) : null;
}

/** Now, Next and Later from core's roadmap read (`ROADMAP_HORIZON_OF`, the lane rule the Requirements list groups by). */
function Roadmap({ s, slug, clock }: { s: Pick<ProjectStatus, "roadmap">; slug: string; clock: EtaClock }) {
  const t = useCopy();
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-3">
      {ROADMAP_HORIZONS.map((h) => (
        <div key={h} data-testid="status-horizon" data-horizon={h}>
          <h3 className="mb-1.5 text-13 font-semibold text-fg">{t(`status.horizon.${h}`)}</h3>
          {s.roadmap[h].length === 0 ? (
            <Quiet>{t("status.horizonEmpty")}</Quiet>
          ) : (
            <ul className={LIST}>
              {s.roadmap[h].map((i) => (
                <li key={i.key} className={ROW}>
                  <Link href={requirementHref(slug, i.key)} className={TITLE_LINK} title={i.key}>
                    {i.title}
                  </Link>
                  {eta(i.delivery, clock)}
                  <Honesty d={i.delivery} moved={i.moved} clock={clock} />
                  {i.deferral ? (
                    <span className="w-full text-13 text-muted">
                      {i.deferral.targetPhase
                        ? t("status.deferredTo", { phase: i.deferral.targetPhase, reason: i.deferral.reason })
                        : t("status.deferred", { reason: i.deferral.reason })}
                    </span>
                  ) : null}
                  {i.state === "draft" ? <span className="w-full text-13 text-muted">{t("status.notAgreed")}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

interface StatusReportProps {
  s: ProjectStatus;
  slug: string;
  clock: EtaClock;
  /** The live read's window control; a kept report has none, its window fixed when it was stored. */
  window?: StatusWindow;
  onWindow?: (w: StatusWindow) => void;
  /** More header actions beside Copy and Print, such as saving the live read. */
  actions?: ReactNode;
}

/** What each part of the report reads. */
interface PartProps {
  s: ProjectStatus;
  slug: string;
  clock: EtaClock;
}

function ShippedPart({ s, slug, clock }: PartProps) {
  const t = useCopy();
  const when = (iso: string) => formatDateTime(iso, clock.lang, clock.timeZone);
  return (
  <ReportPart title={t("status.shipped")} asOf={s.shipped.asOf} clock={clock} count={s.shipped.releaseCount} testId="status-shipped">
    {s.shipped.releases.length === 0 ? (
      <Quiet>{t("status.shippedNone")}</Quiet>
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
            {r.name ? <span className="w-full">{r.name}</span> : null}
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
            <Link href={requirementHref(slug, r.key)} className={NAME_LINK} title={r.key}>
              {r.title}
            </Link>
          </span>
        ))}
      </p>
    ) : null}
    {(s.shipped.requirementsAwaitingProof ?? []).length > 0 ? (
      <p className="mt-1.5 text-13" data-testid="status-awaiting-proof">
        <span className="text-muted">{t("status.requirementsAwaitingProof")}: </span>
        {(s.shipped.requirementsAwaitingProof ?? []).map((r, i) => (
          <span key={r.key}>
            {i > 0 ? ", " : ""}
            <Link href={requirementHref(slug, r.key)} className={NAME_LINK} title={r.key}>
              {r.title}
            </Link>{" "}
            <span className="text-13 text-muted">{t("status.criteriaProven", { proven: r.proven, total: r.total })}</span>
          </span>
        ))}
      </p>
    ) : null}
  </ReportPart>
  );
}

function InFlightPart({ s, slug, clock }: PartProps) {
  const t = useCopy();
  const label = useLabel();
  return (
  <ReportPart title={t("status.inFlight")} asOf={s.inFlight.asOf} clock={clock} count={s.inFlight.open} testId="status-in-flight">
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
            <Link href={issueHref(slug, i.key)} className={TITLE_LINK} title={i.key}>
              <Written text={i.title} lang={i.titleLang} />
            </Link>
            <StatusBadge family="issue" value={i.status} />
          </li>
        ))}
      </ul>
    )}
  </ReportPart>
  );
}

function WaitsPart({ s, slug, clock }: PartProps) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const label = useLabel();
  return (
  <ReportPart title={t("status.waits")} asOf={s.waits.asOf} clock={clock} count={s.waits.peopleCount} testId="status-waits">
    {s.waits.people.length === 0 ? (
      <Quiet>{t("status.waitsNone")}</Quiet>
    ) : (
      <div className="grid gap-4">
        {waitGroups(s.waits).map((g) => (
          <div key={g.person ? `${g.person.kind}:${g.person.who}` : "all"} data-testid="status-wait-person">
            {g.person ? <h3 className="mb-1.5 text-13 font-semibold text-fg">{personHeading(g.person, t, language)}</h3> : null}
            <ul className={LIST}>
              {g.rows.map((x) => (
                <li key={`${x.area}:${x.key}`} className={ROW}>
                  <Link href={needsYouHref(slug, x)} className={TITLE_LINK} title={needsYouKeyLabel(x, (a) => label("needsYouArea", a))}>
                    <Written text={said(x.says.title, language)} lang={x.titleLang} />
                  </Link>
                  <span className="text-13 text-muted">{said(x.waitingOn.says.act, language)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {s.waits.peopleCount > s.waits.people.length ? <p className="text-13 text-muted">{t("status.waitsMore", { n: s.waits.peopleCount - s.waits.people.length })}</p> : null}
      </div>
    )}
  </ReportPart>
  );
}

function RequirementsPart({ s, slug, clock }: PartProps) {
  const t = useCopy();
  return (
  <ReportPart
    title={t("status.requirements")}
    asOf={s.requirements.asOf}
    clock={clock}
    count={s.requirements.items.length}
    note={t("status.criteriaProven", { proven: s.requirements.proven, total: s.requirements.total })}
    testId="status-requirements"
  >
    <p className="mb-2 text-13 font-semibold" data-testid="status-criteria-proven">
      {t("status.criteriaProven", { proven: s.requirements.proven, total: s.requirements.total })}
    </p>
    {s.requirements.items.length === 0 ? (
      <Quiet>{t("status.requirementsNone")}</Quiet>
    ) : (
      <ul className={LIST}>
        {s.requirements.items.map((r) => (
          <li key={r.key} className={ROW}>
            <Link href={requirementHref(slug, r.key)} className={TITLE_LINK} title={r.key}>
              {r.title}
            </Link>
            <StatusBadge family="requirement" value={r.state} />
            <span className="text-13 text-muted">{t("status.criteriaProven", { proven: r.criteria.proven, total: r.criteria.total })}</span>
            <IssueProgressText progress={r.progress} className="text-13 text-muted" />
            {eta(r.delivery, clock)}
            <Honesty d={r.delivery} moved={r.moved} clock={clock} />
          </li>
        ))}
      </ul>
    )}
  </ReportPart>
  );
}

function NextReleasePart({ s, slug, clock }: PartProps) {
  const t = useCopy();
  const label = useLabel();
  return (
  <ReportPart title={t("status.nextRelease")} asOf={s.nextRelease.asOf} clock={clock} note={s.nextRelease.version ?? undefined} testId="status-next-release">
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
  </ReportPart>
  );
}

function LatePart({ s, clock }: Omit<PartProps, "slug">) {
  const t = useCopy();
  return (
  <ReportPart title={t("status.late")} asOf={s.late.asOf} clock={clock} count={s.late.items.length} testId="status-late">
    {s.late.items.length === 0 ? (
      <Quiet>{t("status.lateNone")}</Quiet>
    ) : (
      <ul className={LIST}>
        {s.late.items.map((l) => (
          <li key={`${l.kind}:${l.key}`} className={ROW}>
            <span className="min-w-0 flex-1" title={l.key}>
              {l.title}
            </span>
            <span className="text-13 text-danger">{t(`status.late.${l.late.reason}`, { by: spanText(l.late.byMinutes, clock.lang) })}</span>
          </li>
        ))}
      </ul>
    )}
  </ReportPart>
  );
}

export function StatusReport({ s, slug, clock, window, onWindow, actions }: StatusReportProps) {
  const t = useCopy();
  const label = useLabel();
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const markdown = useMemo(() => statusMarkdown(s, { t, label, clock }), [s, t, label, clock]);
  const when = (iso: string) => formatDateTime(iso, clock.lang, clock.timeZone);
  const copy = () => {
    // a page served without a secure context has no clipboard to write to
    if (!globalThis.isSecureContext) {
      setCopied("failed");
      return;
    }
    navigator.clipboard.writeText(markdown).then(
      () => setCopied("done"),
      () => setCopied("failed"),
    );
  };
  usePageCommands([
    { label: t("status.copy"), icon: "link", onRun: copy },
    { label: t("status.print"), icon: "book", onRun: () => globalThis.print?.() },
  ]);
  return (
    <article data-testid="status-report" className="grid gap-4">
      <header className="mb-4 grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="fg-h2 min-w-0 flex-1">
            {s.name} — {t("status.title")}
          </h1>
          {actions ? <div className="flex items-center gap-2 print:hidden">{actions}</div> : null}
        </div>
        <p className="text-13 text-muted" data-testid="status-as-of">
          {t("status.asOf", { at: when(s.asOf) })} · {t("status.window", { days: s.days })}
        </p>
        {window && onWindow ? (
          <div className="print:hidden">
            <SegmentedControl
              value={window}
              onChange={onWindow}
              options={STATUS_WINDOWS.map((w) => ({ value: w, label: t("status.days", { days: w }) }))}
            />
          </div>
        ) : null}
        {copied === "done" ? (
          <p role="status" className="text-13 text-muted print:hidden" data-testid="status-copied">
            {t("status.copied")}
          </p>
        ) : null}
        {copied === "failed" ? (
          <p role="alert" className="text-13 text-danger">
            {t("status.copyFailed")}
          </p>
        ) : null}
      </header>

      <StuckPart s={s} clock={clock} />

      <NeedsYouPart s={s} clock={clock} />

      <ShippedPart s={s} slug={slug} clock={clock} />

      <InFlightPart s={s} slug={slug} clock={clock} />

      <WaitsPart s={s} slug={slug} clock={clock} />

      <RequirementsPart s={s} slug={slug} clock={clock} />

      <NextReleasePart s={s} slug={slug} clock={clock} />

      <LatePart s={s} clock={clock} />

      <ReportPart title={t("status.roadmap")} asOf={s.roadmap.asOf} clock={clock} testId="status-roadmap">
        <Roadmap s={s} slug={slug} clock={clock} />
      </ReportPart>

      <p className="text-13 text-muted">{t("status.forecastNote")}</p>
    </article>
  );
}
