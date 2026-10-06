"use client";

// cm:why an agent report as the automation read model serves it (ISS-116, design automation rev 1,
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
  ErrorState,
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
  ProjectLoader,
  StatusBadge,
  useUrlTab,
  ViewHeading,
  WaitBanner,
  WaitingOn,
} from "@/design";
import { enumLabel, statusReading } from "@/design/vocabulary";
import { useTriageAgentReport } from "@/features/automation/report-hooks";
import { FeedbackForm } from "@/features/feedback/components/feedback-form";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { formatApiError, formatRefusal, isRetryableApiError } from "@/lib/api/error";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { useAutomationStanding, useReportDetail } from "../hooks";
import { feedbackDraftOf } from "../report-feedback";
import { fireHref, reportHref, scheduleHref, sessionHref } from "@/lib/routes/automation";
import type { ReportStanding } from "../types";
import { shortId } from "../view";

const aboutOf = (r: ReportStanding) => `${enumLabel("agentReportTarget", r.target)}${r.targetRef ? ` ${r.targetRef}` : ""}`;

export const reportRow =
  (hrefOf: (id: string) => string) =>
  (r: ReportStanding): ListRowView => ({
    key: r.id,
    keyLabel: shortId(r.id),
    href: hrefOf(r.id),
    title: r.summary,
    facts: [enumLabel("agentReportKind", r.kind), aboutOf(r), `Severity ${r.severity}`, r.fire ? `From ${r.fire.scheduleName}` : "From a run"],
    state: <StatusBadge family="reportTriage" value={r.triage} />,
    waitingOn: <WaitingOn w={r.waitingOn} />,
    owner: r.fire?.scheduleName ?? "—",
    age: { text: formatAge(r.createdAt), title: `Filed ${formatStamp(r.createdAt)}` },
    dim: r.attentionGroup === "closed",
  });

/** A schedule's reports as hairline rows, each opening the report's page. */
export function ReportLines({ reports, slug }: { reports: readonly ReportStanding[]; slug: string }) {
  if (reports.length === 0) return <FactsEmpty>Its fires filed no reports.</FactsEmpty>;
  return (
    <ul className="border-t border-line-subtle" data-testid="report-lines">
      {reports.map((r) => (
        <li key={r.id} className="border-b border-line-subtle">
          <Link href={reportHref(slug, r.id)} className="flex flex-wrap items-center gap-2 py-2 text-13 hover:bg-hover">
            <StatusBadge family="reportTriage" value={r.triage} />
            <span className="min-w-0 flex-1 truncate">{r.summary}</span>
            <span className="text-subtle">{enumLabel("agentReportKind", r.kind)}</span>
            <span className="font-mono text-11 text-subtle" title={formatStamp(r.createdAt)}>
              {formatAge(r.createdAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ReportBanner({ r, className }: { r: ReportStanding; className?: string }) {
  if (r.triage !== "new") return null;
  const w = r.waitingOn;
  return (
    <WaitBanner
      tone={w.kind === "you" ? "you" : "blocked"}
      head={w.kind === "you" ? "Waiting on you:" : `Waiting on ${w.who}:`}
      body="triage: file an issue, dismiss with a reason, or mark a duplicate"
      rule={r.waitingOn.rule}
      className={className}
      testId="report-banner"
    />
  );
}

function Outcome({ r, slug }: { r: ReportStanding; slug: string }) {
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
        Repeats {shortId(r.duplicateOf)}
      </Link>
    );
  }
  return <span>—</span>;
}

export function ReportFacts({ r, slug }: { r: ReportStanding; slug: string }) {
  return (
    <>
      <FactsGroup title="Triage">
        <Fact label="State">
          <StatusBadge family="reportTriage" value={r.triage} />
        </Fact>
        <Fact label="By">{r.triagedBy?.name ?? "—"}</Fact>
        {r.triagedAt ? (
          <Fact label="When">
            <span title={formatStamp(r.triagedAt)}>{formatAge(r.triagedAt)} ago</span>
          </Fact>
        ) : null}
        <Fact label="Went to">
          <Outcome r={r} slug={slug} />
        </Fact>
        {r.triageReason ? <Fact label="Reason">{r.triageReason}</Fact> : null}
      </FactsGroup>
      <FactsGroup title="Report">
        <Fact label="Kind">
          <EnumBadge family="agentReportKind" value={r.kind} />
        </Fact>
        <Fact label="Severity">{statusReading("severity", r.severity).label}</Fact>
        <Fact label="Target">{aboutOf(r)}</Fact>
      </FactsGroup>
      <FactsGroup title="Source">
        <Fact label="From">
          {r.fire ? (
            <>
              <Link href={fireHref(slug, r.fire.id)} className="font-mono text-12-5 text-link hover:underline">
                #{shortId(r.fire.id)}
              </Link>
              <span className="text-muted">of</span>
              <Link href={scheduleHref(slug, r.fire.scheduleId)} className="text-link hover:underline">
                {r.fire.scheduleName}
              </Link>
            </>
          ) : (
            <span className="text-muted">{r.stage ? `The ${r.stage} step of a run` : "A run"}</span>
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
      File an issue
    </Button>
  ) : (
    <Button type="button" size="sm" disabled={triage.isPending} onClick={() => triage.mutate({ id: r.id, act: { act: "reopen" } })} data-testid="report-reopen">
      Reopen
    </Button>
  );
}

type Form = "dismiss" | "duplicate" | "promote" | null;

/** Every triage act a writer may take, each posting to the triage door. */
function ReportTriage({ r, projectId, slug }: { r: ReportStanding; projectId: string; slug: string }) {
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
      <ViewHeading>What is this report?</ViewHeading>
      {r.triage === "new" ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={triage.isPending} onClick={() => act({ act: "file", createIssue: {} })}>
            File an issue
          </Button>
          <Button type="button" size="sm" onClick={() => setForm("dismiss")} data-testid="report-dismiss-open">
            Dismiss
          </Button>
          <Button type="button" size="sm" onClick={() => setForm("duplicate")} data-testid="report-duplicate-open">
            Mark a duplicate
          </Button>
          <Button type="button" size="sm" onClick={() => setForm("promote")}>
            Promote to feedback
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-13 text-muted">
            {statusReading("reportTriage", r.triage).label}
            {r.triagedBy?.name ? ` by ${r.triagedBy.name}` : ""}.
          </span>
          <Button type="button" size="sm" disabled={triage.isPending} onClick={() => act({ act: "reopen" })}>
            Reopen
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
            aria-label="Why this is not work"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Already fixed in ISS-12, or the agent misread the step"
            className="min-w-[280px] flex-1"
          />
          <Button type="submit" size="sm" disabled={triage.isPending} data-testid="report-dismiss">
            Dismiss
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setForm(null)}>
            Cancel
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
              aria-label="The report this repeats"
              value={dupOf}
              onChange={(e) => setDupOf(e.target.value)}
              options={[
                { value: "", label: "Pick the report this repeats" },
                ...others.map((o) => ({ value: o.id, label: `${shortId(o.id)} · ${o.summary.slice(0, 80)}` })),
              ]}
            />
          </span>
          <Button type="submit" size="sm" disabled={triage.isPending || !dupOf} data-testid="report-duplicate">
            Mark a duplicate
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setForm(null)}>
            Cancel
          </Button>
        </form>
      ) : null}
      {form === "promote" ? (
        <div className="mt-3">
          <FeedbackForm projectId={projectId} agentReport={r.id} draft={feedbackDraftOf(r)} onDone={() => setForm(null)} />
        </div>
      ) : null}
      <Refusal error={triage.error} />
      {r.feedback ? (
        <p className="mt-2 text-12-5 text-muted">
          Became{" "}
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
  return (
    <PeekPanel peek={peek} listLabel="Automation" noun="Agent report" onOpenFull={onOpenFull} testId="report-peek">
      <PeekHead
        noun="Agent report"
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
  return (
    <dl className="grid max-w-[640px] grid-cols-[140px_minmax(0,1fr)] gap-y-2 text-13" data-testid="report-source">
      <dt className="text-muted">Signal</dt>
      <dd className="font-mono text-12-5">{r.signalKey}</dd>
      {r.fire ? (
        <>
          <dt className="text-muted">Fire</dt>
          <dd>
            <Link href={fireHref(slug, r.fire.id)} className="font-mono text-link hover:underline">
              #{shortId(r.fire.id)}
            </Link>{" "}
            of{" "}
            <Link href={scheduleHref(slug, r.fire.scheduleId)} className="text-link hover:underline">
              {r.fire.scheduleName}
            </Link>
          </dd>
        </>
      ) : null}
      {r.sessionId ? (
        <>
          <dt className="text-muted">Session</dt>
          <dd>
            <Link href={sessionHref(slug, r.sessionId)} className="font-mono text-link hover:underline">
              {shortId(r.sessionId)}
            </Link>
          </dd>
        </>
      ) : null}
      {r.stage ? (
        <>
          <dt className="text-muted">Step</dt>
          <dd>{r.stage}</dd>
        </>
      ) : null}
      {r.issueId ? (
        <>
          <dt className="text-muted">Issue run</dt>
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
  const rows = [
    { at: r.createdAt, text: `Filed by the agent as ${enumLabel("agentReportKind", r.kind).toLowerCase()}` },
    ...(r.triagedAt
      ? [
          {
            at: r.triagedAt,
            text: `${statusReading("reportTriage", r.triage).label}${r.triagedBy?.name ? ` by ${r.triagedBy.name}` : ""}${r.triageReason ? `: ${r.triageReason}` : ""}`,
          },
        ]
      : []),
  ];
  return (
    <ol className="border-t border-line-subtle" data-testid="report-history">
      {rows.reverse().map((h) => (
        <li key={h.at} className="flex flex-wrap gap-2 border-b border-line-subtle py-2.5 text-13">
          <span>{h.text}</span>
          <span className="ml-auto text-subtle" title={formatStamp(h.at)}>
            {formatAge(h.at)} ago
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ReportPage({ projectId, slug, reportId, canWrite }: { projectId: string; slug: string; reportId: string; canWrite: boolean }) {
  const q = useReportDetail(projectId, reportId);
  const [tab, setTab] = useUrlTab(REPORT_TABS);
  if (q.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ProjectLoader label="loading the report…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
      </div>
    );
  }
  const r = q.data.report;
  const tabs = [
    { value: "report" as const, label: "Report" },
    { value: "source" as const, label: "Source" },
    { value: "history" as const, label: "History" },
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
      <DetailPane label={tabs.find((t) => t.value === tab)?.label ?? "Report"}>
        {tab === "report" ? (
          <div className="grid gap-8" data-testid="view-report">
            <Prose title="Summary">{r.summary}</Prose>
            <Prose title="Detail">{r.detail}</Prose>
            <Prose title="Suggestion">{r.suggestion}</Prose>
            {canWrite ? <ReportTriage r={r} projectId={projectId} slug={slug} /> : null}
          </div>
        ) : null}
        {tab === "source" ? <Source r={r} slug={slug} /> : null}
        {tab === "history" ? <History r={r} /> : null}
      </DetailPane>
    </DetailLayout>
  );
}
