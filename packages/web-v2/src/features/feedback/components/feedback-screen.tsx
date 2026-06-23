"use client";

// Feedback inbox for steward forge_feedback reports (ISS-557).
// Surfaces feedback_reports to the owner — list/filter, mark-reviewed, session link.
import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  MonoTag,
  NativeSelect,
  PageContainer,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  type SelectOption,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useFeedbackReports, useMarkFeedbackReviewed } from "../hooks";
import {
  kindToBadgeTone,
  severityToBadgeTone,
  type FeedbackFilters,
  type FeedbackKind,
  type FeedbackReport,
  type FeedbackSeverity,
  type FeedbackTarget,
} from "../types";

interface FeedbackScreenProps {
  scope: { projectId: string; canManage: boolean };
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const KIND_OPTIONS: SelectOption[] = [
  { value: "", label: "All kinds" },
  { value: "unclear_step", label: "Unclear step" },
  { value: "skill_gap", label: "Skill gap" },
  { value: "friction", label: "Friction" },
  { value: "learning", label: "Learning" },
  { value: "blocker", label: "Blocker" },
  { value: "policy", label: "Policy" },
];

const SEVERITY_OPTIONS: SelectOption[] = [
  { value: "", label: "All severities" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const TARGET_OPTIONS: SelectOption[] = [
  { value: "", label: "All targets" },
  { value: "skill", label: "Skill" },
  { value: "pipeline", label: "Pipeline" },
  { value: "tool", label: "Tool" },
  { value: "memory", label: "Memory" },
  { value: "issue", label: "Issue" },
  { value: "project", label: "Project" },
  { value: "forge", label: "Forge" },
];

function ReviewButton({
  report,
  projectId,
}: {
  report: FeedbackReport;
  projectId: string;
}) {
  const mutation = useMarkFeedbackReviewed(projectId);
  const isReviewed = !!report.reviewedAt;
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate({ id: report.id, reviewed: !isReviewed })}
    >
      {isReviewed ? "Unmark" : "Mark reviewed"}
    </Button>
  );
}

function SessionLink({ sessionId, slug }: { sessionId: string | null; slug: string | undefined }) {
  if (!sessionId || !slug) return null;
  return (
    <Link
      href={`/projects/${slug}/agents/${sessionId}`}
      className="fg-caption text-accent hover:underline focus-visible:outline-none"
    >
      View session →
    </Link>
  );
}

function ReportRow({
  report,
  slug,
  projectId,
}: {
  report: FeedbackReport;
  slug: string | undefined;
  projectId: string;
}) {
  const muted = !!report.reviewedAt;
  return (
    <TR className={muted ? "opacity-50" : undefined}>
      <TD>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={kindToBadgeTone(report.kind)}>{report.kind.replace(/_/g, " ")}</Badge>
          <Badge tone={severityToBadgeTone(report.severity)}>{report.severity}</Badge>
        </div>
      </TD>
      <TD>
        <Badge tone="neutral">{report.target}</Badge>
        {report.targetRef && (
          <MonoTag style={{ fontSize: 11 }}>{report.targetRef}</MonoTag>
        )}
      </TD>
      <TD className="max-w-xs">
        <p className={`fg-body-sm break-words ${muted ? "line-through text-subtle" : "text-fg"}`}>
          {report.summary}
        </p>
      </TD>
      <TD className="fg-caption text-subtle">{fmtTime(report.createdAt)}</TD>
      <TD>
        <div className="flex flex-col items-start gap-1">
          <ReviewButton report={report} projectId={projectId} />
          <SessionLink sessionId={report.sessionId} slug={slug} />
        </div>
      </TD>
    </TR>
  );
}

function ReportCard({
  report,
  slug,
  projectId,
}: {
  report: FeedbackReport;
  slug: string | undefined;
  projectId: string;
}) {
  const muted = !!report.reviewedAt;
  return (
    <Card>
      <CardContent>
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <Badge tone={kindToBadgeTone(report.kind)}>{report.kind.replace(/_/g, " ")}</Badge>
          <Badge tone={severityToBadgeTone(report.severity)}>{report.severity}</Badge>
          <Badge tone="neutral">{report.target}</Badge>
          {report.targetRef && <MonoTag style={{ fontSize: 11 }}>{report.targetRef}</MonoTag>}
        </div>
        <p className={`fg-body-sm break-words mb-2 ${muted ? "line-through text-subtle" : "text-fg"}`}>
          {report.summary}
        </p>
        <div className="flex items-center justify-between gap-2 mt-2">
          <span className="fg-caption text-subtle">{fmtTime(report.createdAt)}</span>
          <div className="flex flex-col items-end gap-1">
            <ReviewButton report={report} projectId={projectId} />
            <SessionLink sessionId={report.sessionId} slug={slug} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function FeedbackScreen({ scope }: FeedbackScreenProps) {
  const { projectId } = scope;
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;

  const [filters, setFilters] = useState<FeedbackFilters>({});

  const reportsQ = useFeedbackReports(projectId, filters);
  const reports = reportsQ.data ?? [];

  return (
    <PageContainer className="min-h-dvh">
      <header className="mb-6">
        <h1 className="fg-h2">Feedback</h1>
        <p className="fg-body-sm mt-1">
          Steward friction reports. Mark reviewed to track what&apos;s been addressed.
        </p>
      </header>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-2">
        <NativeSelect
          options={KIND_OPTIONS}
          value={filters.kind ?? ""}
          onChange={(e) =>
            setFilters((f) => ({ ...f, kind: (e.target.value as FeedbackKind) || undefined }))
          }
          aria-label="Filter by kind"
        />
        <NativeSelect
          options={SEVERITY_OPTIONS}
          value={filters.severity ?? ""}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              severity: (e.target.value as FeedbackSeverity) || undefined,
            }))
          }
          aria-label="Filter by severity"
        />
        <NativeSelect
          options={TARGET_OPTIONS}
          value={filters.target ?? ""}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              target: (e.target.value as FeedbackTarget) || undefined,
            }))
          }
          aria-label="Filter by target"
        />
      </div>

      {reportsQ.isLoading && (
        <div className="space-y-2.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      )}

      {reportsQ.isError && (
        <ErrorState
          title="Couldn't load feedback"
          message={formatApiError(reportsQ.error)}
          onRetry={() => reportsQ.refetch()}
        />
      )}

      {!reportsQ.isLoading && !reportsQ.isError && reports.length === 0 && (
        <EmptyState title="No feedback yet" message="Steward friction reports will appear here." />
      )}

      {!reportsQ.isLoading && !reportsQ.isError && reports.length > 0 && (
        <>
          {/* Desktop: full table */}
          <div className="hidden md:block">
            <Table>
              <THead>
                <TR>
                  <TH>Kind · severity</TH>
                  <TH>Target</TH>
                  <TH>Summary</TH>
                  <TH>When</TH>
                  <TH>Actions</TH>
                </TR>
              </THead>
              <TBody>
                {reports.map((r) => (
                  <ReportRow key={r.id} report={r} slug={slug} projectId={projectId} />
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: stacked cards */}
          <div className="space-y-2.5 md:hidden">
            {reports.map((r) => (
              <ReportCard key={r.id} report={r} slug={slug} projectId={projectId} />
            ))}
          </div>
        </>
      )}
    </PageContainer>
  );
}
