"use client";

// PM Decisions tab: paginated feed of PM agent decisions
// (`GET /api/projects/:id/pm/decisions`). Reuses the kit Table.
import { useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  MonoTag,
  SessionRowSkeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/design";
import { usePmDecisions } from "../hooks";

const PAGE_SIZE = 25;

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function PmDecisions({ projectId }: { projectId: string }) {
  const [page, setPage] = useState(1);
  const q = usePmDecisions(projectId, page);
  const items = q.data?.items ?? [];
  const total = q.data?.totalCount ?? 0;
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (q.isLoading) {
    return (
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {Array.from({ length: 6 }).map((_, i) => (
          <SessionRowSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return (
      <ErrorState
        title="Couldn't load decisions"
        message="We couldn't reach the PM service. Retry in a moment."
        onRetry={() => q.refetch()}
      />
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        title="No decisions yet"
        message="When the PM agent runs, its decisions — cause, summary, and confidence — appear here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <Table>
        <THead>
          <TR>
            <TH>Cause</TH>
            <TH>Summary</TH>
            <TH className="text-right">Confidence</TH>
            <TH>Model</TH>
            <TH className="text-right">Took</TH>
            <TH>When</TH>
          </TR>
        </THead>
        <TBody>
          {items.map((d) => (
            <TR key={d.id}>
              <TD>
                <Badge tone="neutral">{d.cause}</Badge>
              </TD>
              <TD className="max-w-[360px]">
                <span className="fg-body-sm text-fg">{d.summary}</span>
              </TD>
              <TD className="text-right font-mono text-muted">
                {d.confidence == null ? "—" : `${Math.round(d.confidence * 100)}%`}
              </TD>
              <TD>{d.modelTier ? <MonoTag>{d.modelTier}</MonoTag> : <span className="fg-caption">—</span>}</TD>
              <TD className="text-right font-mono text-muted">{d.tookMs == null ? "—" : `${d.tookMs}ms`}</TD>
              <TD className="fg-caption whitespace-nowrap">{timeLabel(d.createdAt)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>

      {maxPage > 1 && (
        <div className="flex items-center justify-end gap-3">
          <span className="fg-caption font-mono">
            Page {page} / {maxPage}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= maxPage}
            onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
