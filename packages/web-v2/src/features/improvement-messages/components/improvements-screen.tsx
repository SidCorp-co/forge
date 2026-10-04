"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  EnumBadge,
  ErrorState,
  Input,
  PageContainer,
  PageTitle,
  Skeleton,
  StatusBadge,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/design";
import { useTriageAgentReport } from "@/features/agent-reports/hooks";
import type { AgentReport } from "@/features/agent-reports/types";
import { useAutomationStanding } from "@/features/automation/hooks";
import { FeedbackForm } from "@/features/feedback/components/feedback-form";
import { feedbackHref } from "@/features/feedback/routes";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { useImprovementMessages } from "../hooks";
import {
  IMPROVEMENT_FILTERS,
  type ImprovementFilter,
  type ImprovementRow,
  feedbackDraftOf,
  improvementRows,
  matchesFilter,
} from "../improvements";
import { ImproveCatalog } from "./improve-catalog";

const FILTER_LABEL: Record<ImprovementFilter, string> = {
  all: "All",
  reports: "Agent reports",
  proposals: "Proposals",
  done: "Done",
};

const STATE_BADGE: Record<ImprovementRow["state"], { label: string; tone: "amber" | "neutral" | "green" }> = {
  proposal: { label: "Proposal", tone: "amber" },
  report: { label: "Agent report", tone: "neutral" },
  done: { label: "Done", tone: "green" },
};

function useLoopTitles(projectId: string): (scheduleId: string) => string {
  const catalog = useImprovementMessages(projectId).data;
  return useMemo(() => {
    const titles = new Map(
      (catalog ?? []).flatMap((e) => (e.enablement ? [[e.enablement.scheduleId, e.title] as const] : [])),
    );
    return (scheduleId: string) => titles.get(scheduleId) ?? "Improvement loop";
  }, [catalog]);
}

function DismissForm({ report, projectId, onDone }: { report: AgentReport; projectId: string; onDone: () => void }) {
  const triage = useTriageAgentReport(projectId);
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2 bg-surface px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        triage.mutate({ id: report.id, act: { act: "dismiss", reason } }, { onSuccess: onDone });
      }}
    >
      <label htmlFor={`dismiss-${report.id}`} className="fg-label text-fg">
        Why is this not work?
      </label>
      <Input
        id={`dismiss-${report.id}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Already fixed in ISS-12, or the agent misread the step"
        className="min-w-[280px] flex-1"
      />
      <Button type="submit" variant="secondary" size="sm" disabled={triage.isPending}>
        Dismiss
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

function ReopenButton({ report, projectId }: { report: AgentReport; projectId: string }) {
  const triage = useTriageAgentReport(projectId);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={triage.isPending}
      onClick={() => triage.mutate({ id: report.id, act: { act: "reopen" } })}
      aria-label={`Reopen triage of ${report.summary}`}
    >
      Reopen
    </Button>
  );
}

function TriagedAction({ report, projectId, slug, canWrite }: { report: AgentReport; projectId: string; slug: string; canWrite: boolean }) {
  if (report.feedback) {
    const fb = report.feedback;
    return (
      <span className="inline-flex items-center gap-1.5" data-testid="report-became">
        <Link href={feedbackHref(slug, fb.key)} className="fg-caption text-accent hover:underline">
          Became {fb.key} →
        </Link>
        <StatusBadge family="feedbackPhase" value={fb.phase} />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      {report.linkedIssueId ? (
        <Link href={`/projects/${slug}/issues/${report.linkedIssueId}`} className="fg-caption text-accent hover:underline">
          View issue →
        </Link>
      ) : (
        <span className="fg-caption max-w-[260px] truncate text-muted" title={report.triageReason ?? undefined}>
          {report.triage === "duplicate" ? "Repeats an earlier report" : report.triageReason}
          {report.triagedBy?.name ? ` · ${report.triagedBy.name}` : ""}
        </span>
      )}
      {canWrite ? <ReopenButton report={report} projectId={projectId} /> : null}
    </span>
  );
}

function RowAction({
  row,
  projectId,
  slug,
  canWrite,
  onPromote,
  onDismiss,
}: {
  row: ImprovementRow;
  projectId: string;
  slug: string;
  canWrite: boolean;
  onPromote: () => void;
  onDismiss: () => void;
}) {
  const triage = useTriageAgentReport(projectId);
  if (row.source === "proposal") {
    return (
      <Link href={`/projects/${slug}/agents/${row.sessionId}`} className="fg-caption text-accent hover:underline">
        View run →
      </Link>
    );
  }
  if (row.report.triage !== "new") return <TriagedAction report={row.report} projectId={projectId} slug={slug} canWrite={canWrite} />;
  if (!canWrite) return null;
  return (
    <span className="inline-flex gap-1.5">
      <Button
        variant="secondary"
        size="sm"
        disabled={triage.isPending}
        onClick={() => triage.mutate({ id: row.report.id, act: { act: "file", createIssue: {} } })}
        aria-label={`File an issue for ${row.report.summary}`}
      >
        File an issue
      </Button>
      <Button variant="secondary" size="sm" onClick={onDismiss} aria-label={`Dismiss ${row.report.summary}`}>
        Dismiss
      </Button>
      <Button variant="secondary" size="sm" onClick={onPromote} aria-label={`Promote ${row.report.summary} to feedback`}>
        Promote to feedback
      </Button>
    </span>
  );
}

function StateBadge({ row }: { row: ImprovementRow }) {
  if (row.source === "report") return <EnumBadge family="agentReportTriage" value={row.report.triage} />;
  return <Badge tone={STATE_BADGE[row.state].tone}>{STATE_BADGE[row.state].label}</Badge>;
}

export function ImprovementsScreen({
  scope,
  header,
}: {
  scope: { projectId: string; slug: string; canManage: boolean; canWrite: boolean };
  /** The page's title when it hosts this screen as a tab (Automation); the screen's own otherwise. */
  header?: React.ReactNode;
}) {
  const { projectId, slug } = scope;
  const [filter, setFilter] = useState<ImprovementFilter>("all");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const standingQ = useAutomationStanding(projectId);
  const loopTitle = useLoopTitles(projectId);
  const rows = useMemo(
    () => improvementRows(standingQ.data?.reports ?? [], standingQ.data?.proposals ?? [], loopTitle),
    [standingQ.data, loopTitle],
  );
  const shown = rows.filter((r) => matchesFilter(r, filter));
  const loading = standingQ.isLoading;
  const error = standingQ.error;

  return (
    <PageContainer className="min-h-dvh">
      {header ?? (
        <PageTitle hint="What agents report about the harness comes in; the improvement loop's proposals go out. One list for both.">
          Improvements
        </PageTitle>
      )}

      <fieldset className="mb-3 flex flex-wrap gap-1.5 border-0 p-0" aria-label="Show">
        {IMPROVEMENT_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-pill border px-3 py-0.5 text-12-5 font-semibold transition-colors",
              filter === f ? "border-fg bg-fg text-surface" : "border-line bg-surface text-muted hover:text-fg",
            )}
          >
            {FILTER_LABEL[f]} {rows.filter((r) => matchesFilter(r, f)).length}
          </button>
        ))}
      </fieldset>

      {loading && <Skeleton className="h-40 w-full rounded-lg" />}
      {!loading && error != null && <ErrorState title="Couldn't load improvements" message={formatApiError(error)} />}
      {!loading && error == null && shown.length === 0 && (
        <EmptyState
          title={rows.length === 0 ? "Nothing yet" : "Nothing here"}
          message="Agent reports and the improvement loop's proposals appear here."
        />
      )}
      {!loading && error == null && shown.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH>Title</TH>
              <TH>From</TH>
              <TH>State</TH>
              <TH className="sr-only">Action</TH>
            </TR>
          </THead>
          <TBody>
            {shown.map((row) => (
              <Fragment key={row.id}>
                <TR data-testid="improvement-row">
                  <TD className="max-w-[420px]">
                    <p className="fg-body-sm break-words text-fg">{row.title}</p>
                  </TD>
                  <TD className="fg-caption text-muted">{row.from}</TD>
                  <TD>
                    <StateBadge row={row} />
                  </TD>
                  <TD className="text-right">
                    <RowAction
                      row={row}
                      projectId={projectId}
                      slug={slug}
                      canWrite={scope.canWrite}
                      onPromote={() => setPromoting(row.id)}
                      onDismiss={() => setDismissing(row.id)}
                    />
                  </TD>
                </TR>
                {dismissing === row.id && row.source === "report" ? (
                  <TR data-testid="improvement-dismiss">
                    <TD colSpan={4} className="p-0">
                      <DismissForm report={row.report} projectId={projectId} onDone={() => setDismissing(null)} />
                    </TD>
                  </TR>
                ) : null}
                {promoting === row.id && row.source === "report" ? (
                  <TR data-testid="improvement-promote">
                    <TD colSpan={4} className="p-0">
                      <FeedbackForm projectId={projectId} agentReport={row.report.id} draft={feedbackDraftOf(row.report)} onDone={() => setPromoting(null)} />
                    </TD>
                  </TR>
                ) : null}
              </Fragment>
            ))}
          </TBody>
        </Table>
      )}

      <section className="mt-8 border-t border-line pt-4">
        <button
          type="button"
          aria-expanded={catalogOpen}
          onClick={() => setCatalogOpen((o) => !o)}
          className="fg-label inline-flex items-center gap-1 text-fg hover:underline"
        >
          {catalogOpen ? "Hide" : "Configure"} the improvement loop
        </button>
        <p className="fg-caption mt-1 text-muted">Which improvement messages run on this project, how often, and whether they propose or apply.</p>
        {catalogOpen && (
          <div className="mt-4">
            <ImproveCatalog scope={{ projectId, canManage: scope.canManage }} />
          </div>
        )}
      </section>
    </PageContainer>
  );
}
