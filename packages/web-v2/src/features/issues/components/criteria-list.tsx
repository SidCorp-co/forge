"use client";

// ISS-55 — the issue's acceptance criteria, flat: one row per criterion with its verdict badge.
// The identity, reason, author and time sit behind the badge's tooltip, not on the row.

import { PageSectionTitle, EmptyPanelLine, StatusBadge, statusReading, Tooltip } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { type CriterionRow, criterionBadge, identityPhrase, useCriteria } from "../criteria";

function tooltipOf(row: CriterionRow): string {
  const v = row.latest;
  if (!v) return "No verdict recorded yet";
  const by = v.authorAgency === "agent" ? "an agent" : "a person";
  const parts = [
    `${v.verdict === "short" ? "Pass, short of the wording" : statusReading("criterion", v.verdict).label} · ${identityPhrase(v)}`,
    v.reason ? `Reason: ${v.reason}` : null,
    `By ${by}, ${new Date(v.createdAt).toLocaleString()}`,
  ];
  return parts.filter(Boolean).join("\n");
}

export function CriteriaList({ issueId }: { issueId: string }) {
  const q = useCriteria(issueId);
  if (q.isLoading) return <EmptyPanelLine title="Acceptance criteria" status="Loading…" />;
  if (q.isError) {
    return (
      <EmptyPanelLine title="Acceptance criteria" status="Couldn't load" detail={formatApiError(q.error)} />
    );
  }
  const rows = q.data?.criteria ?? [];
  if (rows.length === 0) return null;
  return (
    <section aria-label="Acceptance criteria">
      <PageSectionTitle className="mb-2">Acceptance criteria</PageSectionTitle>
      <ol className="divide-y" style={{ borderColor: "var(--border-subtle)" }}>
        {rows.map((row) => {
          return (
            <li key={row.id} className="flex items-start gap-3 py-2">
              <span className="w-6 shrink-0 tabular-nums" style={{ color: "var(--fg-muted)" }}>
                {row.n}.
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{row.statement}</span>
              <Tooltip label={tooltipOf(row)} multiline>
                <span data-testid={`criterion-${row.n}-verdict`}>
                  <StatusBadge family="criterion" value={criterionBadge(row.latest)} />
                </span>
              </Tooltip>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
