"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import Link from "next/link";
import { EmptyState, ErrorState, PageTitle, ProjectLoader, Tooltip } from "@/design";
import { useProjectDocument } from "@/features/project-settings/config-hooks";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { formatRelativeTime } from "@/lib/utils/format";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { catalogue, sensitivityOf, templateIdOf, templateTitle } from "../catalogue";
import { useWorkflowTemplates, useWorkflows } from "../hooks";
import { workflowHref } from "../routes";
import type { WorkflowRecord } from "../types";
import { SystemOverviewRegion } from "./system-overview";
import { DesignPill, ProposedMarker } from "./workflow-parts";

// cm:why one grid template for the header and every row, so the columns line up without a table
const COLS = "grid grid-cols-[minmax(0,1fr)_170px_84px_230px_92px] gap-x-3.5 px-7 max-lg:grid-cols-[minmax(0,1fr)_150px_76px_210px]";

function size(r: WorkflowRecord): string {
  const n = r.document.steps.length;
  return r.document.kind === "state" ? `${n} ${n === 1 ? "state" : "states"}` : `${n} ${n === 1 ? "step" : "steps"}`;
}

function Row({ r, slug, templates }: { r: WorkflowRecord; slug: string; templates: readonly WorkflowTemplate[] }) {
  const w = r.document;
  // An approved design with a newer revision waiting reads as approved; the marker says what waits.
  const status = r.design.status === "proposed" && r.design.approvedRevision !== null ? "approved" : r.design.status;
  return (
    <Link
      href={workflowHref(slug, w.flow)}
      className={cn(
        COLS,
        "min-h-[50px] items-center border-b border-line-subtle py-2 text-left hover:bg-hover",
        "max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-y-1 max-md:px-4 max-md:py-2.5",
      )}
      data-testid="workflow-row"
      data-flow={w.flow}
    >
      <span className="min-w-0 truncate text-13-5 font-semibold max-md:col-span-2 max-md:whitespace-normal" title={w.summary}>
        {w.title}
      </span>
      <span className="truncate text-12-5 text-muted max-md:order-3" data-testid="workflow-template">
        {templateTitle(templateIdOf(r), templates)}
      </span>
      <span className="text-12-5 tabular-nums text-muted max-md:hidden">{size(r)}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-2 max-md:order-2 max-md:justify-end">
        {status ? <DesignPill status={status} reason={r.design.returnReason ?? null} /> : null}
        <ProposedMarker r={r} />
      </span>
      <span className="text-right text-12-5 text-subtle max-lg:hidden" title={`${new Date(w.updatedAt).toLocaleString()} · ${r.writerName}`}>
        {formatRelativeTime(w.updatedAt)}
      </span>
    </Link>
  );
}

export function WorkflowsScreen({ projectId, slug, projectName }: { projectId: string; slug: string; projectName: string }) {
  const q = useWorkflows(projectId);
  const templatesQ = useWorkflowTemplates(projectId);
  const [picked, setPicked] = useQueryParam("template");
  const projectDocument = useProjectDocument(projectId);

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
  const chips = [...new Set(all.map(templateIdOf))].sort((a, b) => templateTitle(a, templates).localeCompare(templateTitle(b, templates)));
  const filter = picked && chips.includes(picked) ? picked : null;
  const groups = catalogue(filter ? all.filter((r) => templateIdOf(r) === filter) : all);

  return (
    <div className="grid min-h-full content-start bg-app" data-testid="workflows-screen">
      <PageTitle hint="What the system is, then every design the project draws, grouped by what it is for">Workflows</PageTitle>
      {all.length === 0 ? (
        <div className="px-7 py-10 max-md:px-4">
          <EmptyState title="No workflow has been drawn" message="The project's master draws each workflow; none has been written for this project yet." />
        </div>
      ) : (
        <>
          <SystemOverviewRegion
            records={all}
            templates={templates}
            projectId={projectId}
            slug={slug}
            projectName={projectName}
            sensitivity={sensitivityOf(projectDocument.data?.document)}
          />
          <section aria-labelledby="designs-title" className="pt-5">
            <header className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-7 pb-3 max-md:px-4">
              <h2 id="designs-title" className="fg-h3 m-0">
                Designs <span className="font-mono text-13 font-semibold text-muted">{all.length}</span>
              </h2>
              {chips.length > 1 ? (
                <span className="flex flex-wrap gap-1.5" role="tablist" aria-label="Diagram type">
                  {[null, ...chips].map((t) => (
                    <button
                      key={t ?? "all"}
                      type="button"
                      role="tab"
                      aria-selected={filter === t}
                      onClick={() => setPicked(t)}
                      className={cn(
                        "rounded-pill border px-2.5 py-0.5 text-12 font-semibold",
                        filter === t ? "border-fg bg-fg text-surface" : "border-line bg-surface text-muted hover:text-fg",
                      )}
                      data-testid="template-chip"
                    >
                      {t ? templateTitle(t, templates) : "All"}
                    </button>
                  ))}
                </span>
              ) : null}
            </header>
            <div
              aria-hidden
              className={cn(COLS, "h-8 items-center border-y border-line-subtle text-11-5 font-semibold text-subtle max-md:hidden")}
            >
              <span>Design</span>
              <span>Diagram</span>
              <span>Size</span>
              <span>State</span>
              <span className="text-right max-lg:hidden">Updated</span>
            </div>
            <div className="bg-surface" data-testid="workflow-list">
              {groups.map((g) => (
                <div key={g.id} data-testid="workflow-group" data-group={g.id}>
                  <div className="flex min-h-[34px] items-center gap-2 bg-sunken px-7 py-[5px] text-13 max-md:px-4">
                    <Tooltip label={g.hint} side="bottom">
                      <span className="cursor-help font-bold">{g.label}</span>
                    </Tooltip>
                    <span className="font-mono text-12 font-bold text-muted">{g.rows.length}</span>
                  </div>
                  {g.rows.map((r) => (
                    <Row key={r.document.id} r={r} slug={slug} templates={templates} />
                  ))}
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
