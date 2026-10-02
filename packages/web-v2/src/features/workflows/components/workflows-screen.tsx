"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import Link from "next/link";
import { EmptyState, ErrorState, PageTitle, ProjectLoader } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { formatRelativeTime } from "@/lib/utils/format";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { templateFor } from "../canvas/model";
import { WorkflowThumbnail } from "../canvas/thumbnail";
import { useWorkflowTemplates, useWorkflows } from "../hooks";
import { workflowHref } from "../routes";
import type { WorkflowRecord } from "../types";
import { DesignPill } from "./workflow-parts";

/** The chip a design is filtered by: the template it is drawn in, or its kind for one drawn before templates. */
function templateChip(r: WorkflowRecord, templates: readonly WorkflowTemplate[]): string {
  return templateFor(r.document, templates)?.id ?? r.document.kind;
}

function WorkflowCard({ r, slug, templates }: { r: WorkflowRecord; slug: string; templates: readonly WorkflowTemplate[] }) {
  const w = r.document;
  const count = w.steps.length;
  return (
    <Link
      href={workflowHref(slug, w.flow)}
      className="group grid overflow-hidden rounded-lg border border-line-subtle bg-surface shadow-sm transition-colors hover:border-line-strong"
      data-testid="workflow-card"
      data-flow={w.flow}
    >
      <WorkflowThumbnail doc={w} template={templateFor(w, templates)} />
      <div className="grid gap-2 border-t border-line-subtle px-3.5 py-3">
        <div className="flex items-start gap-2">
          <b className="min-w-0 flex-1 text-14 leading-snug group-hover:text-fg">{w.title}</b>
          {r.design.status ? <DesignPill status={r.design.status} reason={r.design.returnReason ?? null} /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-12 text-muted">
          <span className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-11" data-testid="workflow-template">
            {templateChip(r, templates)}
          </span>
          <span>
            {count} {w.kind === "state" ? (count === 1 ? "state" : "states") : count === 1 ? "step" : "steps"}
          </span>
          <span className="ml-auto truncate" title={`Drawn by ${r.writerName}`}>
            {r.writerName}
          </span>
          <span title={new Date(w.updatedAt).toLocaleString()}>{formatRelativeTime(w.updatedAt)}</span>
        </div>
      </div>
    </Link>
  );
}

export function WorkflowsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useWorkflows(projectId);
  const templatesQ = useWorkflowTemplates(projectId);
  const [picked, setPicked] = useQueryParam("template");

  if (q.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading workflows…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
      </div>
    );
  }
  const templates = (templatesQ.data?.templates ?? []).map((t) => t.template);
  const all = q.data.workflows;
  const chips = [...new Set(all.map((r) => templateChip(r, templates)))].sort();
  const filter = picked && chips.includes(picked) ? picked : null;
  const shown = filter ? all.filter((r) => templateChip(r, templates) === filter) : all;

  return (
    <div className="grid content-start gap-4 px-4 pb-8 pt-4 sm:px-7" data-testid="workflows-screen">
      <header className="flex flex-wrap items-center gap-3">
        <PageTitle>Workflows</PageTitle>
        {chips.length > 1 ? (
          <span className="ml-auto flex flex-wrap gap-1.5" role="tablist" aria-label="Template">
            {[null, ...chips].map((t) => (
              <button
                key={t ?? "all"}
                type="button"
                role="tab"
                aria-selected={filter === t}
                onClick={() => setPicked(t)}
                className={cn(
                  "rounded-pill border px-2.5 py-0.5 text-12 font-semibold",
                  filter === t ? "border-fg bg-fg text-surface" : "border-line text-muted hover:text-fg",
                )}
              >
                {t ?? "All"}
              </button>
            ))}
          </span>
        ) : null}
      </header>
      {all.length === 0 ? (
        <EmptyState title="No workflow has been drawn" message="The project's master draws each workflow; none has been written for this project yet." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="workflow-list">
          {shown.map((r) => (
            <WorkflowCard key={r.document.id} r={r} slug={slug} templates={templates} />
          ))}
        </div>
      )}
    </div>
  );
}
