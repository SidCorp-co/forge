
import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { matchesListFilter, waitingFilterOf } from "@forge/contracts/ui-list-filters";
import { useReportShown } from "@/design/hooks/use-page-shown";
import { ListFilterBar, useListFilter } from "@/features/chat-dock";
import { Button, EmptyState, PageTitle, RowItem, SegmentedControl, rememberListOrigin, useUrlChoice } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useAskForDesigns } from "@/features/onboarding";
import { useOnboardingState } from "@/features/onboarding";
import { useProjectDocument } from "@/features/project-config";
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { readingOrder, systemContextOf, templateIdOf, templateTitle } from "../catalogue";
import { useWorkflowTemplates, useWorkflows } from "../hooks";
import { WORKFLOWS_LIST, workflowHref } from "@/lib/routes/workflows";
import type { WorkflowRecord } from "../types";
import { NewDesign } from "./new-design";
import { SystemOverviewRegion } from "./system-overview";
import { HealthSummaryChips } from "./health-parts";
import { DesignPill, DesignWaits, ProposedMarker } from "./workflow-parts";

function size(r: WorkflowRecord, t: Copy): string {
  const n = r.document.steps.length;
  return r.document.kind === "state"
    ? t(n === 1 ? "workflows.count.state.one" : "workflows.count.state.many", { n })
    : t(n === 1 ? "workflows.count.step.one" : "workflows.count.step.many", { n });
}

/** The keys of a design's linked requirements, or None (REQ-10 BC-13). */
function RequirementKeys({ keys }: { keys: readonly string[] }) {
  const t = useCopy();
  return (
    <span className={cn("font-mono text-12", keys.length ? "font-semibold text-fg" : "text-subtle")} data-testid="workflow-requirements">
      {keys.length ? keys.join(" · ") : t("workflows.facts.none")}
    </span>
  );
}

/** The state every listed design shares, said once above the list rather than on each row (REQ-43 BC-5). */
interface SharedState {
  status: boolean;
  waits: boolean;
}

const statusKey = (r: WorkflowRecord) => JSON.stringify([r.design.shown, r.design.returnReason ?? null, r.design.pendingRevision]);
const waitKey = (r: WorkflowRecord) => JSON.stringify([r.design.waitingOn.kind, r.design.waitingOn.who, r.design.waitingOn.act]);

function sharedState(rows: readonly WorkflowRecord[]): SharedState {
  const one = (key: (r: WorkflowRecord) => string) => rows.length > 1 && new Set(rows.map(key)).size === 1;
  return { status: one(statusKey), waits: one(waitKey) };
}

/** A design in the list: its whole title, wrapped and never cut (REQ-17 BC-29), what it is drawn in, its requirement, its size and age, then its state and health. */
function DesignItem({ r, slug, templates, narrow, shared }: { r: WorkflowRecord; slug: string; templates: readonly WorkflowTemplate[]; narrow: boolean; shared: SharedState }) {
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
      stack={narrow}
      wrap
      rowKey={w.flow}
      title={<span title={w.summary}>{w.title}</span>}
      facts={[
        <span key="t" data-testid="workflow-template">{templateTitle(templateIdOf(r), templates, label)}</span>,
        <RequirementKeys key="r" keys={r.requirements} />,
        size(r, t),
        <span key="u" title={`${time.dateTime(w.updatedAt)} · ${r.writerName}`}>{time.relative(w.updatedAt)}</span>,
      ]}
      trailing={
        <>
          {status && !shared.status ? <DesignPill status={status} reason={r.design.returnReason ?? null} /> : null}
          {shared.status ? null : <ProposedMarker r={r} />}
          {shared.waits ? null : <DesignWaits r={r} />}
          <HealthSummaryChips health={r.health} />
        </>
      }
    />
  );
}

/** Whether the viewer owes an act on any design, said once (REQ-10 BC-14): the count, or None. */
function NeedsYou({ rows }: { rows: readonly WorkflowRecord[] }) {
  const t = useCopy();
  const n = rows.filter((r) => r.design.waitingOn.kind === "you").length;
  return (
    <span className="inline-flex items-baseline gap-1.5 text-13" data-testid="workflows-needs-you" data-count={n}>
      <span className="text-muted">{t("workflows.needsYou")}</span>
      <b className={cn("font-semibold", n ? "text-accent-text" : "text-fg")}>{n ? n : t("workflows.facts.none")}</b>
    </span>
  );
}

function Designs({
  all,
  projectId,
  slug,
  templates,
  narrow,
}: {
  all: readonly WorkflowRecord[];
  projectId: string;
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
  const rows = readingOrder(narrowed);
  useReportShown(rows.map((r) => r.document.flow));
  const shared = sharedState(rows);
  const first = rows[0];
  const pad = "px-3";
  return (
    <section aria-labelledby="designs-title" className={cn(narrow ? "pt-3.5" : "pt-5")} data-testid="designs">
      <header className={cn("flex flex-wrap items-center gap-x-4 gap-y-2.5 pb-3", pad)}>
        <h2 id="designs-title" className="fg-h3 m-0">
          {t("workflows.designs")} <span className="font-mono text-13 font-semibold text-muted">{all.length}</span>
        </h2>
        <NeedsYou rows={all} />
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
        <span className="ml-auto">
          <NewDesign projectId={projectId} slug={slug} templates={templates} />
        </span>
      </header>
      {first && (shared.status || shared.waits) ? (
        <div className={cn("flex min-h-8.5 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-subtle bg-sunken py-1.25 text-13", pad)} data-testid="workflows-shared">
          {shared.status && first.design.shown ? <DesignPill status={first.design.shown} reason={first.design.returnReason ?? null} /> : null}
          {shared.status ? <ProposedMarker r={first} /> : null}
          {shared.waits ? <DesignWaits r={first} /> : null}
        </div>
      ) : null}
      <ul className="border-t border-line-subtle" data-testid="workflow-list">
        {rows.map((r) => (
          <DesignItem key={r.document.id} r={r} slug={slug} templates={templates} narrow={narrow} shared={shared} />
        ))}
      </ul>
    </section>
  );
}

/** No design yet: the owner asks for the first ones here, confirmed before the job that draws them runs. */
function NoWorkflows({ projectId, slug, templates }: { projectId: string; slug: string; templates: readonly WorkflowTemplate[] }) {
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
      <div className="mt-3 flex justify-center">
        <NewDesign projectId={projectId} slug={slug} templates={templates} />
      </div>
      {dialog}
    </div>
  );
}

/**
 * Workflows: what the system is on the left (one line, its facts and its system-context design on the
 * shared canvas), every design the project draws on the right, grouped by what it is for. A project with
 * no system context yet gets the onboarding line and the list across the page.
 */
const NARROW_VIEWS = ["designs", "map"] as const;

/** Below `lg` the split holds one half at a time: the designs list first, the map one tap away. */
function NarrowViewSwitch({ value, onChange }: { value: (typeof NARROW_VIEWS)[number]; onChange: (next: (typeof NARROW_VIEWS)[number]) => void }) {
  const t = useCopy();
  return (
    <div className="flex h-12 flex-none items-center border-b border-line-subtle bg-surface px-4 lg:hidden" data-testid="workflows-view">
      <SegmentedControl options={NARROW_VIEWS.map((v) => ({ value: v, label: t(`workflows.view.${v}`) }))} value={value} onChange={onChange} />
    </div>
  );
}

export function WorkflowsScreen({ projectId, slug, projectName, canEdit = false }: { projectId: string; slug: string; projectName: string; canEdit?: boolean }) {
  const t = useCopy();
  const q = useWorkflows(projectId);
  const templatesQ = useWorkflowTemplates(projectId);
  const projectDocument = useProjectDocument(projectId);
  const [view, setView] = useUrlChoice("view", NARROW_VIEWS, "designs");
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
            narrowView={view}
            className="flex-1"
          />
        );

        if (systemContextOf(all)) {
          return (
            <div className="flex min-h-0 flex-1 flex-col bg-app" data-testid="workflows-screen">
              <PageTitle>{t("workflows.title")}</PageTitle>
              <NarrowViewSwitch value={view} onChange={setView} />
              <div className="flex min-h-0 flex-1 max-lg:flex-col lg:[contain:size]" data-testid="workflows-split">
                {overview}
                <aside className={cn("w-100 flex-none overflow-y-auto border-l border-line-subtle bg-surface max-lg:w-full max-lg:overflow-visible max-lg:border-l-0 max-lg:border-t", view === "map" && "max-lg:hidden")} data-testid="workflows-list-pane">
                  <Designs all={all} projectId={projectId} slug={slug} templates={templates} narrow />
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
              <NoWorkflows projectId={projectId} slug={slug} templates={templates} />
            ) : (
              <Designs all={all} projectId={projectId} slug={slug} templates={templates} narrow={false} />
            )}
          </div>
        );
      }}
    </QueryBoundary>
  );
}
