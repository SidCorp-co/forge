"use client";

// an agent report as the automation read model serves it (ISS-116, design automation rev 1,
// steps wait_triage, triage, file and dismiss): its triage state and whom it waits on come from core,
// and every triage act posts to the one triage door, so a refusal is shown by the code it came back with
import Link from "next/link";
import { useState } from "react";
import {
  Button,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  EnumBadge,
  Fact,
  FactsEmpty,
  FactsGroup,
  FactsRail,
  Input,
  type ListRowView,
  NativeSelect,
  PeekHead,
  PeekPanel,
  type PeekState,
  StatusBadge,
  useUrlTab,
  ViewHeading,
  WaitBanner,
  WaitingOn,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { enumLabel, statusReading } from "@/design/vocabulary";
import { useTriageAgentReport } from "@/features/automation/report-hooks";
import { FeedbackForm } from "@/features/feedback/components/feedback-form";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { formatRefusal } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { baseOf, copyOr } from "@/lib/i18n/product-copy";
import { standingWho } from "@/lib/i18n/standing-copy";
import { useAutomationStanding, useReportDetail } from "../hooks";
import { feedbackDraftOf } from "../report-feedback";
import { fireHref, reportHref, scheduleHref, sessionHref } from "@/lib/routes/automation";
import type { ReportStanding } from "../types";
import { type RowCtx, shortId } from "../view";

/** A step as the reader says it where the vocabulary names it, as the agent wrote it elsewhere. */
const stageWord = (stage: string, language: string) => (baseOf(language) === "en" ? stage : copyOr(language, `label.workStep.${stage}`, stage));

const aboutOf = (r: ReportStanding, language: string) => `${enumLabel("agentReportTarget", r.target, language)}${r.targetRef ? ` ${r.targetRef}` : ""}`;

export const reportRow =
  (hrefOf: (id: string) => string, { t, language, time }: RowCtx) =>
  (r: ReportStanding): ListRowView => ({
    key: r.id,
    keyLabel: shortId(r.id),
    href: hrefOf(r.id),
    title: r.summary,
    facts: [
      enumLabel("agentReportKind", r.kind, language),
      aboutOf(r, language),
      t("schedules.report.severity", { severity: statusReading("severity", r.severity, language).label.toLowerCase() }),
      r.fire ? t("schedules.report.from", { name: r.fire.scheduleName }) : t("schedules.report.fromRun"),
    ],
    state: <StatusBadge family="reportTriage" value={r.triage} />,
    waitingOn: <WaitingOn w={r.waitingOn} />,
    owner: r.fire?.scheduleName ?? "—",
    age: { text: time.age(r.createdAt), title: t("schedules.report.filedAt", { at: time.dateTime(r.createdAt) }) },
    dim: r.attentionGroup === "closed",
  });

/** A schedule's reports as hairline rows, each opening the report's page. */
export function ReportLines({ reports, slug }: { reports: readonly ReportStanding[]; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  if (reports.length === 0) return <FactsEmpty>{t("schedules.report.noReports")}</FactsEmpty>;
  return (
    <ul className="border-t border-line-subtle" data-testid="report-lines">
      {reports.map((r) => (
        <li key={r.id} className="border-b border-line-subtle">
          <Link href={reportHref(slug, r.id)} className="flex flex-wrap items-center gap-2 py-2 text-13 hover:bg-hover">
            <StatusBadge family="reportTriage" value={r.triage} />
            <span className="min-w-0 flex-1 truncate">{r.summary}</span>
            <span className="text-subtle">{enumLabel("agentReportKind", r.kind, language)}</span>
            <span className="font-mono text-11 text-subtle" title={time.dateTime(r.createdAt)}>
              {time.age(r.createdAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ReportBanner({ r, className }: { r: ReportStanding; className?: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  if (r.triage !== "new") return null;
  const w = r.waitingOn;
  return (
    <WaitBanner
      tone={w.kind === "you" ? "you" : "blocked"}
      head={w.kind === "you" ? t("schedules.waitingOnYou") : t("schedules.waitingOnWho", { who: standingWho(w.who, language) })}
      body={t("schedules.report.bannerBody")}
      rule={r.waitingOn.rule}
      className={className}
      testId="report-banner"
    />
  );
}

function Outcome({ r, slug }: { r: ReportStanding; slug: string }) {
  const t = useCopy();
  if (r.feedback) {
    return (
      <Link href={feedbackHref(slug, r.feedback.key)} className="font-mono text-12-5 text-link hover:underline">
        {r.feedback.key}
      </Link>
    );
  }
  if (r.linkedIssueId) {
    const key = r.waitingOn.kind === "issue" && r.waitingOn.ref ? r.waitingOn.ref : r.linkedIssueId;
    return (
      <Link href={issueHref(slug, key)} className="font-mono text-12-5 text-link hover:underline">
        {r.waitingOn.ref ?? shortId(r.linkedIssueId)}
      </Link>
    );
  }
  if (r.duplicateOf) {
    return (
      <Link href={reportHref(slug, r.duplicateOf)} className="font-mono text-12-5 text-link hover:underline">
        {t("schedules.report.repeats", { id: shortId(r.duplicateOf) })}
      </Link>
    );
  }
  return <span>—</span>;
}

export function ReportFacts({ r, slug }: { r: ReportStanding; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  return (
    <>
      <FactsGroup title={t("schedules.report.triage")}>
        <Fact label={t("schedules.report.state")}>
          <StatusBadge family="reportTriage" value={r.triage} />
        </Fact>
        <Fact label={t("schedules.report.by")}>{r.triagedBy?.name ?? "—"}</Fact>
        {r.triagedAt ? (
          <Fact label={t("schedules.report.when")}>
            <span title={time.dateTime(r.triagedAt)}>{t("schedules.ago", { age: time.age(r.triagedAt) })}</span>
          </Fact>
        ) : null}
        <Fact label={t("schedules.report.wentTo")}>
          <Outcome r={r} slug={slug} />
        </Fact>
        {r.triageReason ? <Fact label={t("schedules.report.reason")}>{r.triageReason}</Fact> : null}
      </FactsGroup>
      <FactsGroup title={t("schedules.report.report")}>
        <Fact label={t("schedules.report.kind")}>
          <EnumBadge family="agentReportKind" value={r.kind} />
        </Fact>
        <Fact label={t("schedules.report.severityLabel")}>{statusReading("severity", r.severity, language).label}</Fact>
        <Fact label={t("schedules.report.target")}>{aboutOf(r, language)}</Fact>
      </FactsGroup>
      <FactsGroup title={t("schedules.report.source")}>
        <Fact label={t("schedules.report.fromLabel")}>
          {r.fire ? (
            <>
              <Link href={fireHref(slug, r.fire.id)} className="font-mono text-12-5 text-link hover:underline">
                #{shortId(r.fire.id)}
              </Link>
              <span className="text-muted">{t("schedules.report.of")}</span>
              <Link href={scheduleHref(slug, r.fire.scheduleId)} className="text-link hover:underline">
                {r.fire.scheduleName}
              </Link>
            </>
          ) : (
            <span className="text-muted">{r.stage ? t("schedules.report.stepOfRun", { stage: stageWord(r.stage, language) }) : t("schedules.report.aRun")}</span>
          )}
        </Fact>
      </FactsGroup>
    </>
  );
}

function Refusal({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="mt-2 text-12-5 text-danger" data-testid="triage-refusal">
      {formatRefusal(error)}
    </p>
  );
}

/** The one primary act: file a new report as an issue, or reopen a triaged one. */
export function ReportPrimary({ r, projectId, canWrite }: { r: ReportStanding; projectId: string; canWrite: boolean }) {
  const t = useCopy();
  const triage = useTriageAgentReport(projectId);
  if (!canWrite) return null;
  return r.triage === "new" ? (
    <Button
      type="button"
      variant="primary"
      size="sm"
      disabled={triage.isPending}
      onClick={() => triage.mutate({ id: r.id, act: { act: "file", createIssue: {} } })}
      data-testid="report-file"
    >
      {t("schedules.report.fileIssue")}
    </Button>
  ) : (
    <Button type="button" size="sm" disabled={triage.isPending} onClick={() => triage.mutate({ id: r.id, act: { act: "reopen" } })} data-testid="report-reopen">
      {t("schedules.report.reopen")}
    </Button>
  );
}

type Form = "dismiss" | "duplicate" | "promote" | null;

/** Every triage act a writer may take, each posting to the triage door. */
function ReportTriage({ r, projectId, slug }: { r: ReportStanding; projectId: string; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const triage = useTriageAgentReport(projectId);
  const standing = useAutomationStanding(projectId).data;
  const [form, setForm] = useState<Form>(null);
  const [reason, setReason] = useState("");
  const [dupOf, setDupOf] = useState("");
  const others = (standing?.reports ?? [])
    .filter((o) => o.id !== r.id)
    .sort((a, b) => Number(b.signalKey === r.signalKey) - Number(a.signalKey === r.signalKey));
  const act = (a: Parameters<typeof triage.mutate>[0]["act"]) => triage.mutate({ id: r.id, act: a }, { onSuccess: () => setForm(null) });
  return (
    <section id="report-act" data-testid="report-triage">
      <ViewHeading>{t("schedules.report.whatIs")}</ViewHeading>
      {r.triage === "new" ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={triage.isPending} onClick={() => act({ act: "file", createIssue: {} })}>
            {t("schedules.report.fileIssue")}
          </Button>
          <Button type="button" size="sm" onClick={() => setForm("dismiss")} data-testid="report-dismiss-open">
            {t("schedules.report.dismiss")}
          </Button>
          <Button type="button" size="sm" onClick={() => setForm("duplicate")} data-testid="report-duplicate-open">
            {t("schedules.report.markDuplicate")}
          </Button>
          <Button type="button" size="sm" onClick={() => setForm("promote")}>
            {t("schedules.report.promote")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-13 text-muted">
            {r.triagedBy?.name
              ? t("schedules.report.triagedBy", { state: statusReading("reportTriage", r.triage, language).label, name: r.triagedBy.name })
              : statusReading("reportTriage", r.triage, language).label}
            .
          </span>
          <Button type="button" size="sm" disabled={triage.isPending} onClick={() => act({ act: "reopen" })}>
            {t("schedules.report.reopen")}
          </Button>
        </div>
      )}
      {form === "dismiss" ? (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            act({ act: "dismiss", reason });
          }}
        >
          <Input
            aria-label={t("schedules.report.whyNotWork")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("schedules.report.dismissPlaceholder")}
            className="min-w-[280px] flex-1"
          />
          <Button type="submit" size="sm" disabled={triage.isPending} data-testid="report-dismiss">
            {t("schedules.report.dismiss")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setForm(null)}>
            {t("schedules.form.cancel")}
          </Button>
        </form>
      ) : null}
      {form === "duplicate" ? (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dupOf) act({ act: "duplicate", duplicateOf: dupOf });
          }}
        >
          <span className="min-w-[280px] flex-1">
            <NativeSelect
              aria-label={t("schedules.report.repeatsWhich")}
              value={dupOf}
              onChange={(e) => setDupOf(e.target.value)}
              options={[
                { value: "", label: t("schedules.report.pickRepeats") },
                ...others.map((o) => ({ value: o.id, label: `${shortId(o.id)} · ${o.summary.slice(0, 80)}` })),
              ]}
            />
          </span>
          <Button type="submit" size="sm" disabled={triage.isPending || !dupOf} data-testid="report-duplicate">
            {t("schedules.report.markDuplicate")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setForm(null)}>
            {t("schedules.form.cancel")}
          </Button>
        </form>
      ) : null}
      {form === "promote" ? (
        <div className="mt-3">
          <FeedbackForm projectId={projectId} agentReport={r.id} draft={feedbackDraftOf(r, language)} onDone={() => setForm(null)} />
        </div>
      ) : null}
      <Refusal error={triage.error} />
      {r.feedback ? (
        <p className="mt-2 text-12-5 text-muted">
          {t("schedules.report.became")}{" "}
          <Link href={feedbackHref(slug, r.feedback.key)} className="text-link hover:underline">
            {r.feedback.key}
          </Link>
        </p>
      ) : null}
    </section>
  );
}

export function ReportPeek({
  r,
  projectId,
  slug,
  canWrite,
  peek,
  onOpenFull,
}: {
  r: ReportStanding;
  projectId: string;
  slug: string;
  canWrite: boolean;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  const t = useCopy();
  return (
    <PeekPanel peek={peek} listLabel={t("schedules.title")} noun={t("schedules.noun.agentReport")} onOpenFull={onOpenFull} testId="report-peek">
      <PeekHead
        noun={t("schedules.noun.agentReport")}
        itemKey={shortId(r.id)}
        badge={<StatusBadge family="reportTriage" value={r.triage} />}
        title={r.summary}
        action={<ReportPrimary r={r} projectId={projectId} canWrite={canWrite} />}
      />
      <ReportBanner r={r} className="px-[18px]" />
      <div className="grid gap-5 px-[18px] pb-4 pt-4">
        {canWrite ? <ReportTriage r={r} projectId={projectId} slug={slug} /> : null}
        <ReportFacts r={r} slug={slug} />
      </div>
    </PeekPanel>
  );
}

const REPORT_TABS = ["report", "source", "history"] as const;

function Prose({ title, children }: { title: string; children: string | null }) {
  if (!children) return null;
  return (
    <section>
      <ViewHeading>{title}</ViewHeading>
      <p className="max-w-[80ch] whitespace-pre-wrap text-14 leading-relaxed">{children}</p>
    </section>
  );
}

function Source({ r, slug }: { r: ReportStanding; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  return (
    <dl className="grid max-w-[640px] grid-cols-[140px_minmax(0,1fr)] gap-y-2 text-13" data-testid="report-source">
      <dt className="text-muted">{t("schedules.report.signal")}</dt>
      <dd className="font-mono text-12-5">{r.signalKey}</dd>
      {r.fire ? (
        <>
          <dt className="text-muted">{t("schedules.report.fire")}</dt>
          <dd>
            <Link href={fireHref(slug, r.fire.id)} className="font-mono text-link hover:underline">
              #{shortId(r.fire.id)}
            </Link>{" "}
            {t("schedules.report.of")}{" "}
            <Link href={scheduleHref(slug, r.fire.scheduleId)} className="text-link hover:underline">
              {r.fire.scheduleName}
            </Link>
          </dd>
        </>
      ) : null}
      {r.sessionId ? (
        <>
          <dt className="text-muted">{t("schedules.report.session")}</dt>
          <dd>
            <Link href={sessionHref(slug, r.sessionId)} className="font-mono text-link hover:underline">
              {shortId(r.sessionId)}
            </Link>
          </dd>
        </>
      ) : null}
      {r.stage ? (
        <>
          <dt className="text-muted">{t("schedules.report.step")}</dt>
          <dd>{stageWord(r.stage, language)}</dd>
        </>
      ) : null}
      {r.issueId ? (
        <>
          <dt className="text-muted">{t("schedules.report.issueRun")}</dt>
          <dd>
            <Link href={issueHref(slug, r.issueId)} className="font-mono text-link hover:underline">
              {shortId(r.issueId)}
            </Link>
          </dd>
        </>
      ) : null}
    </dl>
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
  const [tab, setTab] = useUrlTab(REPORT_TABS);
  return (
    <QueryBoundary query={q} loadingLabel={t("schedules.report.loading")}>
      {(data) => {
        const r = data.report;
        const tabs = [
          { value: "report" as const, label: t("schedules.report.tabReport") },
          { value: "source" as const, label: t("schedules.report.tabSource") },
          { value: "history" as const, label: t("schedules.report.tabHistory") },
        ];
        return (
          <DetailLayout
            testId="report-detail"
            dataKey={r.id}
            rail={
              <FactsRail>
                <ReportFacts r={r} slug={slug} />
              </FactsRail>
            }
          >
            <DetailMobileTitle itemKey={shortId(r.id)} title={r.summary} badge={<StatusBadge family="reportTriage" value={r.triage} />} />
            <ReportBanner r={r} className="px-8 py-2.5 max-md:px-4" />
            <DetailTabs tabs={tabs} value={tab} onChange={setTab} testId="report-tabs" />
            <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("schedules.report.tabReport")}>
              {tab === "report" ? (
                <div className="grid gap-8" data-testid="view-report">
                  <Prose title={t("schedules.report.summary")}>{r.summary}</Prose>
                  <Prose title={t("schedules.report.detail")}>{r.detail}</Prose>
                  <Prose title={t("schedules.report.suggestion")}>{r.suggestion}</Prose>
                  {canWrite ? <ReportTriage r={r} projectId={projectId} slug={slug} /> : null}
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
