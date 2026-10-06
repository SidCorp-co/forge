"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import Link from "next/link";
import { Button, EmptyState, ErrorState, PageTitle, ProjectLoader, rememberListOrigin, Tooltip } from "@/design";
import { useProjectDocument } from "@/features/project-config/hooks";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { formatRelativeTime } from "@/lib/utils/format";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { catalogue, systemContextOf, templateIdOf, templateTitle } from "../catalogue";
import { useWorkflowTemplates, useWorkflows } from "../hooks";
import { WORKFLOWS_LIST, workflowHref } from "@/lib/routes/workflows";
import type { WorkflowRecord } from "../types";
import { SystemOverviewRegion } from "./system-overview";
import { HealthSummaryChips } from "./health-parts";
import { DesignPill, ProposedMarker } from "./workflow-parts";

// One grid template for the header and every row, so the columns line up without a table
const COLS = "grid grid-cols-[minmax(0,1fr)_170px_84px_230px_minmax(0,220px)_92px] gap-x-3.5 px-7 max-lg:grid-cols-[minmax(0,1fr)_150px_76px_210px_minmax(0,180px)]";

function size(r: WorkflowRecord): string {
  const n = r.document.steps.length;
  return r.document.kind === "state" ? `${n} ${n === 1 ? "state" : "states"}` : `${n} ${n === 1 ? "step" : "steps"}`;
}

function Row({ r, slug, templates }: { r: WorkflowRecord; slug: string; templates: readonly WorkflowTemplate[] }) {
  const w = r.document;
  const status = r.design.shown;
  return (
    <Link
      href={workflowHref(slug, w.flow)}
      onClick={() => rememberListOrigin(WORKFLOWS_LIST)}
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
      <span className="min-w-0 max-md:order-4 max-md:col-span-2">
        <HealthSummaryChips health={r.health} />
      </span>
      <span className="text-right text-12-5 text-subtle max-lg:hidden" title={`${new Date(w.updatedAt).toLocaleString()} · ${r.writerName}`}>
        {formatRelativeTime(w.updatedAt)}
      </span>
    </Link>
  );
}

/** A design in the narrow list beside the overview: its title and state, then what it is drawn in, its size and age. */
function NarrowRow({ r, slug, templates }: { r: WorkflowRecord; slug: string; templates: readonly WorkflowTemplate[] }) {
  const w = r.document;
  const status = r.design.shown;
  return (
    <Link
      href={workflowHref(slug, w.flow)}
      onClick={() => rememberListOrigin(WORKFLOWS_LIST)}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-line-subtle px-5 py-2.5 text-left hover:bg-hover max-md:px-4"
      data-testid="workflow-row"
      data-flow={w.flow}
    >
      <span className="min-w-0 truncate text-13-5 font-semibold" title={w.summary}>
        {w.title}
      </span>
      <span className="flex items-center gap-2 justify-self-end">
        {status ? <DesignPill status={status} reason={r.design.returnReason ?? null} /> : null}
        <ProposedMarker r={r} />
      </span>
      <span className="col-span-2 truncate text-12 text-muted" title={`${new Date(w.updatedAt).toLocaleString()} · ${r.writerName}`}>
        <span data-testid="workflow-template">{templateTitle(templateIdOf(r), templates)}</span> · {size(r)} · {formatRelativeTime(w.updatedAt)}
      </span>
      <span className="col-span-2 min-w-0 empty:hidden">
        <HealthSummaryChips health={r.health} />
      </span>
    </Link>
  );
}

function Designs({
  all,
  slug,
  templates,
  narrow,
}: {
  all: readonly WorkflowRecord[];
  slug: string;
  templates: readonly WorkflowTemplate[];
  /** Beside the overview: two-line rows, no column header. */
  narrow: boolean;
}) {
  const [picked, setPicked] = useQueryParam("template");
  const chips = [...new Set(all.map(templateIdOf))].sort((a, b) => templateTitle(a, templates).localeCompare(templateTitle(b, templates)));
  const filter = picked && chips.includes(picked) ? picked : null;
  const groups = catalogue(filter ? all.filter((r) => templateIdOf(r) === filter) : all);
  const pad = narrow ? "px-5 max-md:px-4" : "px-7 max-md:px-4";
  return (
    <section aria-labelledby="designs-title" className={cn(narrow ? "pt-3.5" : "pt-5")} data-testid="designs">
      <header className={cn("flex flex-wrap items-center gap-x-4 gap-y-2.5 pb-3", pad)}>
        <h2 id="designs-title" className="fg-h3 m-0">
          Designs <span className="font-mono text-13 font-semibold text-muted">{all.length}</span>
        </h2>
        {chips.length > 1 ? (
          <span className="flex flex-wrap gap-1.5" role="tablist" aria-label="Diagram type">
            {[null, ...chips].map((t) => (
              <Button
                key={t ?? "all"}
                type="button"
                variant="ghost"
                size="sm"
                role="tab"
                aria-selected={filter === t}
                onClick={() => setPicked(t)}
                className={cn(
                  "h-auto rounded-pill border px-2.5 py-0.5 text-12 font-semibold",
                  filter === t ? "border-fg bg-fg text-surface" : "border-line bg-surface text-muted hover:text-fg",
                )}
                data-testid="template-chip"
              >
                {t ? templateTitle(t, templates) : "All"}
              </Button>
            ))}
          </span>
        ) : null}
      </header>
      {narrow ? null : (
        <div aria-hidden className={cn(COLS, "h-8 items-center border-y border-line-subtle text-11-5 font-semibold text-subtle max-md:hidden")}>
          <span>Design</span>
          <span>Diagram</span>
          <span>Size</span>
          <span>State</span>
          <span>Health</span>
          <span className="text-right max-lg:hidden">Updated</span>
        </div>
      )}
      <div className={cn("bg-surface", narrow && "border-t border-line-subtle")} data-testid="workflow-list">
        {groups.map((g) => (
          <div key={g.id} data-testid="workflow-group" data-group={g.id}>
            <div className={cn("flex min-h-[34px] items-center gap-2 bg-sunken py-[5px] text-13", pad)}>
              <Tooltip label={g.hint} side="bottom">
                <span className="cursor-help font-bold">{g.label}</span>
              </Tooltip>
              <span className="font-mono text-12 font-bold text-muted">{g.rows.length}</span>
            </div>
            {g.rows.map((r) => (narrow ? <NarrowRow key={r.document.id} r={r} slug={slug} templates={templates} /> : <Row key={r.document.id} r={r} slug={slug} templates={templates} />))}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Workflows: what the system is on the left (one line, its facts and its system-context design on the
 * shared canvas), every design the project draws on the right, grouped by what it is for. A project with
 * no system context yet gets the onboarding line and the list across the page.
 */
export function WorkflowsScreen({ projectId, slug, projectName, canEdit = false }: { projectId: string; slug: string; projectName: string; canEdit?: boolean }) {
  const q = useWorkflows(projectId);
  const templatesQ = useWorkflowTemplates(projectId);
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
  const overview = (
    <SystemOverviewRegion
      records={all}
      templates={templates}
      projectId={projectId}
      slug={slug}
      projectName={projectName}
      projectDocument={projectDocument.data}
      canEdit={canEdit}
      className="flex-1"
    />
  );

  if (systemContextOf(all)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-app" data-testid="workflows-screen">
        <PageTitle hint="What the system is, beside every design the project draws">Workflows</PageTitle>
        <div className="flex min-h-0 flex-1 max-lg:flex-col lg:[contain:size]" data-testid="workflows-split">
          {overview}
          <aside className="w-[400px] flex-none overflow-y-auto border-l border-line-subtle bg-surface max-lg:w-full max-lg:overflow-visible max-lg:border-l-0 max-lg:border-t" data-testid="workflows-list-pane">
            <Designs all={all} slug={slug} templates={templates} narrow />
          </aside>
        </div>
      </div>
    );
  }
  return (
    <div className="grid min-h-full content-start bg-app" data-testid="workflows-screen">
      <PageTitle hint="What the system is, then every design the project draws, grouped by what it is for">Workflows</PageTitle>
      {overview}
      {all.length === 0 ? (
        <div className="px-7 py-10 max-md:px-4">
          <EmptyState title="No workflow has been drawn" message="The project's master draws each workflow; none has been written for this project yet." />
        </div>
      ) : (
        <Designs all={all} slug={slug} templates={templates} narrow={false} />
      )}
    </div>
  );
}
