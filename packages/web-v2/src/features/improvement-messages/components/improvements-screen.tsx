"use client";

import { useQueries } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PageContainer,
  PageTitle,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/design";
import { useAgentReports, useMarkAgentReportReviewed } from "@/features/agent-reports/hooks";
import type { AgentReport } from "@/features/agent-reports/types";
import { useCreateIssue } from "@/features/issues/hooks";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { useToast } from "@/providers/toast-provider";
import { improvementMessagesApi } from "../api";
import { useImprovementMessages } from "../hooks";
import {
  IMPROVEMENT_FILTERS,
  type ImprovementFilter,
  type ImprovementRow,
  type LoopRuns,
  improvementRows,
  issueFromReport,
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

function useLoopRuns(projectId: string) {
  const catalogQ = useImprovementMessages(projectId);
  const loops = (catalogQ.data ?? []).flatMap((e) => (e.enablement ? [{ title: e.title, id: e.enablement.scheduleId }] : []));
  const runsQ = useQueries({
    queries: loops.map((l) => ({
      queryKey: ["improvement-messages", projectId, "runs", l.id],
      queryFn: () => improvementMessagesApi.runs(l.id),
    })),
  });
  const runs: LoopRuns[] = loops.map((l, i) => ({ title: l.title, runs: runsQ[i]?.data?.runs ?? [] }));
  const error = catalogQ.error ?? runsQ.find((q) => q.error)?.error ?? null;
  return { runs, isLoading: catalogQ.isLoading || runsQ.some((q) => q.isLoading), error };
}

function OpenIssueButton({ report, projectId }: { report: AgentReport; projectId: string }) {
  const create = useCreateIssue(projectId);
  const review = useMarkAgentReportReviewed(projectId);
  const { toast } = useToast();
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={create.isPending || review.isPending}
      onClick={async () => {
        try {
          const issue = await create.mutateAsync(issueFromReport(report));
          review.mutate({ id: report.id, reviewed: true, linkedIssueId: issue.id });
          toast({ title: `Opened ${issue.displayId}`, tone: "success" });
        } catch (err) {
          toast({ title: "Couldn't open an issue", description: formatApiError(err), tone: "error" });
        }
      }}
      aria-label={`Open an issue for ${report.summary}`}
    >
      Open issue
    </Button>
  );
}

function RowAction({ row, projectId, slug, canWrite }: { row: ImprovementRow; projectId: string; slug: string; canWrite: boolean }) {
  if (row.source === "proposal") {
    return (
      <Link href={`/projects/${slug}/agents/${row.sessionId}`} className="fg-caption text-accent hover:underline">
        View run →
      </Link>
    );
  }
  if (row.report.linkedIssueId) {
    return (
      <Link href={`/projects/${slug}/issues/${row.report.linkedIssueId}`} className="fg-caption text-accent hover:underline">
        View issue →
      </Link>
    );
  }
  if (row.state === "report" && canWrite) return <OpenIssueButton report={row.report} projectId={projectId} />;
  return null;
}

export function ImprovementsScreen({
  scope,
}: {
  scope: { projectId: string; slug: string; canManage: boolean; canWrite: boolean };
}) {
  const { projectId, slug } = scope;
  const [filter, setFilter] = useState<ImprovementFilter>("all");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const reportsQ = useAgentReports(projectId);
  const loops = useLoopRuns(projectId);
  const rows = useMemo(() => improvementRows(reportsQ.data ?? [], loops.runs), [reportsQ.data, loops.runs]);
  const shown = rows.filter((r) => matchesFilter(r, filter));
  const loading = reportsQ.isLoading || loops.isLoading;
  const error = reportsQ.error ?? loops.error;

  return (
    <PageContainer className="min-h-dvh">
      <PageTitle
          hint="What agents report about the harness comes in; the improvement loop's proposals go out. One list for both."
        >
          Improvements
      </PageTitle>

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
              <TR key={row.id} data-testid="improvement-row">
                <TD className="max-w-[420px]">
                  <p className="fg-body-sm break-words text-fg">{row.title}</p>
                </TD>
                <TD className="fg-caption text-muted">{row.from}</TD>
                <TD>
                  <Badge tone={STATE_BADGE[row.state].tone}>{STATE_BADGE[row.state].label}</Badge>
                </TD>
                <TD className="text-right">
                  <RowAction row={row} projectId={projectId} slug={slug} canWrite={scope.canWrite} />
                </TD>
              </TR>
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
