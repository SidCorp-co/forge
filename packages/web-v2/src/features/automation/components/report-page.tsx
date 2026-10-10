"use client";

// A report's full page: what the agent wrote, where it came from, and its triage history. The person
// view is its state and its summary, which the header cuts to one line; the agent's detail and
// suggestion, its signal, ids and source sit in the Developer view (REQ-43 BC-7).
import Link from "next/link";
import {
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  FactsRail,
  Section,
  Property,
  PropertyList,
  RecordViewSwitch,
  StatusBadge,
  useRecordView,
  useUrlTab,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { enumLabel, statusReading } from "@/design/vocabulary";
import { issueHref } from "@/lib/routes/issues";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { useReportDetail } from "../hooks";
import { fireHref, scheduleHref, sessionHref } from "@/lib/routes/automation";
import type { ReportStanding } from "../types";
import { shortId } from "../view";
import { Written, WrittenMark } from "@/lib/i18n/written";
import type { WrittenLang } from "@forge/contracts/written-lang";
import { ReportBanner, ReportProperties, ReportTriage, stageWord } from "./report-views";

const REPORT_TABS = ["report", "source", "history"] as const;

function Prose({ title, children, lang }: { title: string; children: string | null; lang?: WrittenLang | null }) {
  if (!children) return null;
  return (
    <Section title={title}>
      <p className="max-w-3xl whitespace-pre-wrap text-14 leading-relaxed" lang={lang ?? undefined}>
        {children}
        <WrittenMark lang={lang} />
      </p>
    </Section>
  );
}

function Source({ r, slug }: { r: ReportStanding; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  return (
    <PropertyList testId="report-source">
      <Property label={t("schedules.report.signal")}>
        <span className="font-mono">{r.signalKey}</span>
      </Property>
      {r.fire ? (
        <Property label={t("schedules.report.fire")}>
          <Link href={fireHref(slug, r.fire.id)} className="font-mono text-link hover:underline">
            #{shortId(r.fire.id)}
          </Link>
          {t("schedules.report.of")}
          <Link href={scheduleHref(slug, r.fire.scheduleId)} className="text-link hover:underline">
            {r.fire.scheduleName}
          </Link>
        </Property>
      ) : null}
      {r.sessionId ? (
        <Property label={t("schedules.report.session")}>
          <Link href={sessionHref(slug, r.sessionId)} className="font-mono text-link hover:underline">
            {shortId(r.sessionId)}
          </Link>
        </Property>
      ) : null}
      {r.stage ? <Property label={t("schedules.report.step")}>{stageWord(r.stage, language)}</Property> : null}
      {r.issueId ? (
        <Property label={t("schedules.report.issueRun")}>
          <Link href={issueHref(slug, r.issueId)} className="font-mono text-link hover:underline">
            {shortId(r.issueId)}
          </Link>
        </Property>
      ) : null}
    </PropertyList>
  );
}

function History({ r }: { r: ReportStanding }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const rows = [
    { at: r.createdAt, text: t("schedules.report.filedByAgent", { kind: enumLabel("agentReportKind", r.kind, language).toLowerCase() }) },
    ...(r.triagedAt
      ? [
          {
            at: r.triagedAt,
            text: `${r.triagedBy?.name ? t("schedules.report.triagedBy", { state: statusReading("reportTriage", r.triage, language).label, name: r.triagedBy.name }) : statusReading("reportTriage", r.triage, language).label}${r.triageReason ? `: ${r.triageReason}` : ""}`,
          },
        ]
      : []),
  ];
  return (
    <ol className="border-t border-line-subtle" data-testid="report-history">
      {rows.reverse().map((h) => (
        <li key={h.at} className="flex flex-wrap gap-2 border-b border-line-subtle py-2.5 text-13">
          <span>{h.text}</span>
          <span className="ml-auto text-subtle" title={time.dateTime(h.at)}>
            {t("schedules.ago", { age: time.age(h.at) })}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ReportPage({ projectId, slug, reportId, canWrite }: { projectId: string; slug: string; reportId: string; canWrite: boolean }) {
  const t = useCopy();
  const q = useReportDetail(projectId, reportId);
  const [chosen, setTab] = useUrlTab(REPORT_TABS);
  const [view, onView] = useRecordView();
  const developer = view === "developer";
  const tab = chosen === "source" && !developer ? "report" : chosen;
  return (
    <QueryBoundary query={q} loadingLabel={t("schedules.report.loading")}>
      {(data) => {
        const r = data.report;
        const tabs = [
          { value: "report" as const, label: t("schedules.report.tabReport") },
          ...(developer ? [{ value: "source" as const, label: t("schedules.report.tabSource") }] : []),
          { value: "history" as const, label: t("schedules.report.tabHistory") },
        ];
        return (
          <DetailLayout
            testId="report-detail"
            dataKey={r.id}
            rail={
              <FactsRail>
                <ReportProperties r={r} slug={slug} developer={developer} />
              </FactsRail>
            }
          >
            <DetailMobileTitle itemKey={developer ? shortId(r.id) : undefined} title={<Written text={r.summary} lang={r.writtenLang} />} badge={<StatusBadge family="reportTriage" value={r.triage} />} />
            <ReportBanner r={r} className="px-8 py-2.5 max-md:px-4" />
            <div className="flex justify-end px-8 pt-3 max-md:px-4" data-testid="report-view-bar">
              <RecordViewSwitch view={view} onView={onView} />
            </div>
            <DetailTabs tabs={tabs} value={tab} onChange={setTab} testId="report-tabs" />
            <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("schedules.report.tabReport")}>
              {tab === "report" ? (
                <div data-testid="view-report">
                  <Prose title={t("schedules.report.summary")} lang={r.writtenLang}>{r.summary}</Prose>
                  {canWrite ? <ReportTriage r={r} projectId={projectId} /> : null}
                  {developer ? (
                    <>
                      <Prose title={t("schedules.report.detail")} lang={r.writtenLang}>{r.detail}</Prose>
                      <Prose title={t("schedules.report.suggestion")} lang={r.writtenLang}>{r.suggestion}</Prose>
                    </>
                  ) : null}
                </div>
              ) : null}
              {tab === "source" ? <Source r={r} slug={slug} /> : null}
              {tab === "history" ? <History r={r} /> : null}
            </DetailPane>
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}
