"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { matchesListFilter, waitingFilterOf } from "@forge/contracts/ui-list-filters";
import { useReportShown } from "@/design/hooks/use-page-shown";
import { ListFilterBar, useListFilter } from "@/features/chat-dock";
import { Button, EmptyState, PageTitle, RowItem, rememberListOrigin } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useAskForDesigns } from "@/features/onboarding";
import { useOnboardingState } from "@/features/onboarding";
import { useProjectDocument } from "@/features/project-config";
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { catalogue, systemContextOf, templateIdOf, templateTitle } from "../catalogue";
import { useWorkflowTemplates, useWorkflows } from "../hooks";
import { WORKFLOWS_LIST, workflowHref } from "@/lib/routes/workflows";
import type { WorkflowRecord } from "../types";
import { SystemOverviewRegion } from "./system-overview";
import { HealthSummaryChips } from "./health-parts";
import { DesignPill, DesignWaits, ProposedMarker } from "./workflow-parts";

function size(r: WorkflowRecord, t: Copy): string {
  const n = r.document.steps.length;
  return r.document.kind === "state"
    ? t(n === 1 ? "workflows.count.state.one" : "workflows.count.state.many", { n })
    : t(n === 1 ? "workflows.count.step.one" : "workflows.count.step.many", { n });
}

/** A design in the list: its title, what it is drawn in, its size and age, then its state and health. */
function DesignItem({ r, slug, templates }: { r: WorkflowRecord; slug: string; templates: readonly WorkflowTemplate[] }) {
  const t = useCopy();
  const label = useLabel();
  const time = useTimeFormat();
  const w = r.document;
  const status = r.design.shown;
  return (
    <RowItem
      href={workflowHref(slug, w.flow)}
      onClick={() => rememberListOrigin(WORKFLOWS_LIST)}
      testId="workflow-row"
      title={<span title={w.summary}>{w.title}</span>}
      facts={[<span key="t" data-testid="workflow-template">{templateTitle(templateIdOf(r), templates, label)}</span>, size(r, t), <span key="u" title={`${time.dateTime(w.updatedAt)} · ${r.writerName}`}>{time.relative(w.updatedAt)}</span>]}
      trailing={
        <>
          {status ? <DesignPill status={status} reason={r.design.returnReason ?? null} /> : null}
          <ProposedMarker r={r} />
          <DesignWaits r={r} />
          <HealthSummaryChips health={r.health} />
        </>
      }
    />
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
  const t = useCopy();
  const label = useLabel();
  const [picked, setPicked] = useQueryParam("template");
  const chips = [...new Set(all.map(templateIdOf))].sort((a, b) => templateTitle(a, templates, label).localeCompare(templateTitle(b, templates, label)));
  const filter = picked && chips.includes(picked) ? picked : null;
  // whom a design waits on and its words are the list filter the chat sets too (REQ-41 BC-5)
  const narrowing = useListFilter("workflows");
  const narrowed = all.filter(
    (r) =>
      (!filter || templateIdOf(r) === filter) &&
      matchesListFilter(narrowing, { waiting: waitingFilterOf({ waitingOn: r.design.waitingOn }), text: `${r.document.flow} ${r.document.title} ${r.document.summary}` }),
  );
  const groups = catalogue(narrowed, t);
  useReportShown(groups.flatMap((g) => g.rows.map((r) => r.document.flow)));
  const pad = "px-3";
  return (
    <section aria-labelledby="designs-title" className={cn(narrow ? "pt-3.5" : "pt-5")} data-testid="designs">
      <header className={cn("flex flex-wrap items-center gap-x-4 gap-y-2.5 pb-3", pad)}>
        <h2 id="designs-title" className="fg-h3 m-0">
          {t("workflows.designs")} <span className="font-mono text-13 font-semibold text-muted">{all.length}</span>
        </h2>
        {chips.length > 1 ? (
          <span className="flex flex-wrap gap-1.5" role="tablist" aria-label={t("workflows.diagramType")}>
            {[null, ...chips].map((k) => (
              <Button
                key={k ?? "all"}
                type="button"
                variant="ghost"
                size="sm"
                role="tab"
                aria-selected={filter === k}
                onClick={() => setPicked(k)}
                className={cn(
                  "h-auto rounded-pill border px-2.5 py-0.5 text-12 font-semibold",
                  filter === k ? "border-fg bg-fg text-surface" : "border-line bg-surface text-muted hover:text-fg",
                )}
                data-testid="template-chip"
              >
                {k ? templateTitle(k, templates, label) : t("workflows.all")}
              </Button>
            ))}
          </span>
        ) : null}
        <span className="flex flex-wrap items-center gap-1.5" data-testid="workflows-filter">
          <ListFilterBar list="workflows" />
        </span>
      </header>
      <div className="border-t border-line-subtle" data-testid="workflow-list">
        {groups.map((g) => (
          <div key={g.id} data-testid="workflow-group" data-group={g.id}>
            <div className={cn("flex min-h-8.5 items-center gap-2 bg-sunken py-1.25 text-13", pad)}>
              <span className="font-bold">{g.label}</span>
              <span className="font-mono text-12 font-bold text-muted">{g.rows.length}</span>
            </div>
            <ul>
              {g.rows.map((r) => (
                <DesignItem key={r.document.id} r={r} slug={slug} templates={templates} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** No design yet: the owner asks for the first ones here, confirmed before the job that draws them runs. */
function NoWorkflows({ projectId }: { projectId: string }) {
  const t = useCopy();
  const state = useOnboardingState(projectId);
  const hint = state.data?.hint;
  const { ask, dialog, error } = useAskForDesigns(projectId);
  const action = hint?.action ?? "start";
  // no action until the onboarding is read: a default of "start" taken before it arrives asks for a
  // second job beside the one running, and is refused (ISS-268)
  return (
    <div className="px-7 py-10 max-md:px-4" data-testid="no-workflows">
      <EmptyState
        message={t("workflows.empty")}
        action={state.data ? { label: action === "start" ? t("workflows.askForDesigns") : (hint?.actionLabel ?? t("workflows.openOnboarding")), onClick: () => ask(action) } : undefined}
      />
      {error ? (
        <p role="alert" className="text-center text-12 text-danger-11">
          {error}
        </p>
      ) : null}
      {dialog}
    </div>
  );
}

/**
 * Workflows: what the system is on the left (one line, its facts and its system-context design on the
 * shared canvas), every design the project draws on the right, grouped by what it is for. A project with
 * no system context yet gets the onboarding line and the list across the page.
 */
export function WorkflowsScreen({ projectId, slug, projectName, canEdit = false }: { projectId: string; slug: string; projectName: string; canEdit?: boolean }) {
  const t = useCopy();
  const q = useWorkflows(projectId);
  const templatesQ = useWorkflowTemplates(projectId);
  const projectDocument = useProjectDocument(projectId);
  return (
    <QueryBoundary query={q} loadingLabel={t("workflows.loadingList")} height="60vh" retry="always">
      {(data) => {
        const templates = (templatesQ.data?.templates ?? []).map((x) => x.template);
        const all = data.workflows;
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
              <PageTitle>{t("workflows.title")}</PageTitle>
              <div className="flex min-h-0 flex-1 max-lg:flex-col lg:[contain:size]" data-testid="workflows-split">
                {overview}
                <aside className="w-100 flex-none overflow-y-auto border-l border-line-subtle bg-surface max-lg:w-full max-lg:overflow-visible max-lg:border-l-0 max-lg:border-t" data-testid="workflows-list-pane">
                  <Designs all={all} slug={slug} templates={templates} narrow />
                </aside>
              </div>
            </div>
          );
        }
        return (
          <div className="grid min-h-full content-start bg-app" data-testid="workflows-screen">
            <PageTitle>{t("workflows.title")}</PageTitle>
            {overview}
            {all.length === 0 ? (
              <NoWorkflows projectId={projectId} />
            ) : (
              <Designs all={all} slug={slug} templates={templates} narrow={false} />
            )}
          </div>
        );
      }}
    </QueryBoundary>
  );
}
