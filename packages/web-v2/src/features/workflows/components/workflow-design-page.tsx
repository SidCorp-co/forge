"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import {
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  FactsRail,
  StatusBadge,
  useUrlTab,
  ViewHeading,
} from "@/design";
import { DecisionsPanel } from "@/features/comments/components/decisions-panel";
import { ItemMemory, useItemMemoryCount } from "@/features/memory/components/item-memory";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { readCanvas, titleOf } from "../canvas/model";
import { revisionReason } from "../decision-words";
import { WorkflowCanvas } from "../canvas/workflow-canvas";
import { type DesignDiff, diffOf, stepsWithRemoved } from "../design-diff";
import { stepsForLayer } from "../health";
import { useHealthOverlay, useWorkflowHealth } from "../hooks";
import type { RevisionChanges } from "@forge/contracts/workflows";
import { revisionSummary } from "../revision-summary";
import type { WorkflowBody, WorkflowDesign, WorkflowRecord, WorkflowStep } from "../types";
import { DesignBanner } from "./design-banner";
import { OrphanedTraces } from "./design-decision";
import { useBannerOpen, useCanvasFocus, useDetailSqueezes, useRailCollapsed } from "./design-room";
import { WorkflowDesignFacts } from "./workflow-design-facts";
import { DesignPill } from "./workflow-parts";

const DESIGN_TABS = ["design", "steps", "revisions", "decisions", "memory"] as const;
type DesignTab = (typeof DESIGN_TABS)[number];

export const useDesignTab = () => useUrlTab(DESIGN_TABS);

const MARK: Record<string, ProductCopyKey> = { added: "workflows.mark.added", changed: "workflows.mark.changed", removed: "workflows.mark.removed" };

function StepRows({ steps, numbered, diff, revision }: { steps: WorkflowStep[]; numbered: Map<string, number>; diff: DesignDiff | null; revision: number }) {
  const t = useCopy();
  return (
    <ul>
      {steps.map((s) => {
        const mark = diff?.steps.get(s.id);
        return (
          <li key={s.id} className="grid grid-cols-[36px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)] items-baseline gap-x-3 border-b border-line-subtle px-3 py-2.5 text-13 max-md:grid-cols-[28px_minmax(0,1fr)]" data-testid="design-step-row" data-step={s.id} data-mark={mark}>
            <span className="font-mono text-12 text-subtle">{numbered.get(s.id) ?? ""}</span>
            <span className="min-w-0">
              <span className="font-medium" title={s.node?.purpose ?? s.does}>
                {titleOf(s)}
              </span>
              {mark ? (
                <span className="ml-2 text-12 font-semibold text-accent-text" title={t("workflows.markHint", { r: revision, mark: (MARK[mark] ? t(MARK[mark]) : mark).toLowerCase() })}>
                  {t("workflows.markIn", { mark: MARK[mark] ? t(MARK[mark]) : mark, r: revision })}
                </span>
              ) : null}
            </span>
            <span className="min-w-0 text-muted max-md:col-start-2">{s.node?.owner ?? "—"}</span>
            <span className="min-w-0 text-muted max-md:col-start-2">{s.node?.sla ?? "—"}</span>
          </li>
        );
      })}
    </ul>
  );
}

function StepsPane({ shown, template, diff, revision }: { shown: WorkflowBody; template: WorkflowTemplate | null; diff: DesignDiff | null; revision: number }) {
  const t = useCopy();
  const c = readCanvas(shown, template, t);
  const numbered = new Map(shown.steps.map((s, i) => [s.id, i + 1]));
  const groups = c.bands.length > 0 ? c.bands.map((b) => ({ id: b.id, label: b.label, steps: b.steps.flatMap((id) => c.steps.get(id) ?? []) })) : [{ id: "all", label: "", steps: shown.steps }];
  const unit = shown.kind === "state" ? t("workflows.unit.state") : t("workflows.unit.step");
  return (
    <div data-testid="view-steps">
      <ViewHeading>{t("workflows.whoOwnsWhat")}</ViewHeading>
      <div className="grid h-8 grid-cols-[36px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)] items-center gap-x-3 border-y border-line-subtle bg-sunken px-3 text-11-5 font-semibold text-subtle max-md:hidden" aria-hidden>
        <span>#</span>
        <span>{unit}</span>
        <span>{t("workflows.owner")}</span>
        <span>{t("workflows.deadline")}</span>
      </div>
      {groups.map((g) => (
        <section key={g.id} data-testid="design-step-group">
          {g.label ? <h3 className="border-b border-line-subtle px-3 pb-1.5 pt-4 text-13 font-semibold text-fg">{g.label}</h3> : null}
          <StepRows steps={g.steps} numbered={numbered} diff={diff} revision={revision} />
        </section>
      ))}
    </div>
  );
}

function RevisionSummary({ changes, first }: { changes: RevisionChanges | null; first: boolean }) {
  const line = revisionSummary(changes, first, useCopy());
  if (!line) return null;
  return (
    <span className="mb-0.5 block text-fg" data-testid="revision-summary">
      {line}
    </span>
  );
}

function RevisionsPane({ d }: { d: WorkflowDesign }) {
  const t = useCopy();
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  return (
    <div data-testid="view-revisions">
      <ViewHeading right={<span className="text-12 text-subtle">{t("workflows.newestFirst")}</span>}>{t("workflows.tab.revisions")}</ViewHeading>
      {d.revisions.length === 0 ? (
        <p className="text-13 text-subtle">{t("workflows.noRevisions")}</p>
      ) : (
        <ul className="border-t border-line-subtle">
          {d.revisions.map((r) => (
            <li key={r.revision} className="grid grid-cols-[72px_150px_minmax(0,1fr)] items-baseline gap-x-3 border-b border-line-subtle px-3 py-2.5 text-13 max-md:grid-cols-[56px_minmax(0,1fr)]" data-testid="revision-row">
              <span className="font-mono text-12-5 font-semibold">r{r.revision}</span>
              <span>
                <StatusBadge family="designRevision" value={r.state} />
              </span>
              <span className="min-w-0 text-muted max-md:col-start-2">
                <RevisionSummary changes={r.changes} first={d.revisions[d.revisions.length - 1]?.revision === r.revision} />
                <span title={time.dateTime(r.proposedAt)}>
                  {t("workflows.proposedBy", { who: r.proposedByName ?? r.proposedBy })} · {time.relative(r.proposedAt)}
                </span>
                {r.decidedAt ? (
                  <span title={time.dateTime(r.decidedAt)}>
                    {" "}
                    ·{" "}
                    {r.decidedByName
                      ? t(r.decision === "return" ? "workflows.returnedBy" : "workflows.approvedBy", { who: r.decidedByName })
                      : t(r.decision === "return" ? "workflows.returned" : "workflows.approved")}
                  </span>
                ) : null}
                {r.reason ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer select-none text-12-5 font-medium text-muted hover:text-fg">{r.decision === "approve" ? t("workflows.approvalNote") : t("workflows.reason")}</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words text-12-5 text-fg">{revisionReason(r, language)}</p>
                  </details>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface DesignPageProps {
  projectId: string;
  slug: string;
  d: WorkflowDesign;
  record: WorkflowRecord;
  template: WorkflowTemplate | null;
  decisionCount?: number;
  tab: DesignTab;
  onTab: (t: DesignTab) => void;
  /** The waiting decision's parts for the banner, where the viewer can take it. */
  decision?: { acts: ReactNode; detail: ReactNode; alert: ReactNode } | null;
  walkDecision?: ReactNode;
  /** The act that clears this base's pin-only dependents, where it has any. */
  repins?: ReactNode;
}

export function shownDesign(d: WorkflowDesign, record: WorkflowRecord) {
  const latest = d.revisions[0] ?? null;
  const pending = d.status === "proposed" || d.status === "returned";
  const shown = pending && latest ? latest.document : record.document;
  const shownRevision = pending && latest ? latest.revision : record.revision;
  const approved = d.revisions.find((r) => r.revision === d.approvedRevision)?.document ?? null;
  const canDiff = approved !== null && pending && latest !== null && latest.revision !== d.approvedRevision;
  return { shown, shownRevision, approved: canDiff ? approved : null };
}

/** The fold on the canvas's right edge that hides or shows the facts rail; wide screens only, where the rail sits beside it. */
function RailEdge({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const t = useCopy();
  const label = collapsed ? t("workflows.rail.show") : t("workflows.rail.hide");
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={label}
      title={label}
      className={cn(
        "absolute top-1/2 z-30 flex h-12 w-5 -translate-y-1/2 items-center justify-center border border-line-subtle bg-surface text-muted hover:bg-hover hover:text-fg max-lg:hidden",
        collapsed ? "right-0 rounded-l-sm border-r-0" : "-right-px rounded-l-sm",
      )}
      data-testid="design-rail-toggle"
    >
      {collapsed ? <PanelRightOpen size={14} aria-hidden /> : <PanelRightClose size={14} aria-hidden />}
    </button>
  );
}

export function WorkflowDesignPage({ projectId, slug, d, record, template, decisionCount, tab, onTab, decision, walkDecision, repins }: DesignPageProps) {
  const t = useCopy();
  const [changes, setChanges] = useState(false);
  const [focusOn, setFocus] = useCanvasFocus();
  const focus = focusOn && tab === "design";
  const [railCollapsed, setRailCollapsed] = useRailCollapsed();
  const [bannerOpen, setBannerOpen] = useBannerOpen();
  const [floatOpen, setFloatOpen] = useState(false);
  const column = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const squeezed = useDetailSqueezes(column, headRef, detailRef, { active: tab === "design" && !focus, open: `${bannerOpen}|${floatOpen}` });
  const { shown, shownRevision, approved } = shownDesign(d, record);
  const health = useWorkflowHealth(projectId, record.document.id).data;
  const overlay = useHealthOverlay(health, "design", slug, record.document.flow);
  const fullDiff = approved && health?.diff && health.diff.to === shownRevision ? diffOf(health.diff, approved) : null;
  const diff = changes ? fullDiff : null;
  const memories = useItemMemoryCount(projectId, record.document.flow);
  const tabs = [
    { value: "design" as const, label: t("workflows.tab.design") },
    { value: "steps" as const, label: shown.kind === "state" ? t("workflows.tab.states") : t("workflows.tab.steps"), count: shown.steps.length },
    { value: "revisions" as const, label: t("workflows.tab.revisions"), count: d.revisions.length },
    { value: "decisions" as const, label: t("workflows.tab.decisions"), ...(decisionCount !== undefined ? { count: decisionCount } : {}) },
    { value: "memory" as const, label: t("memory.title"), count: memories },
  ];
  const badge = d.status ? <DesignPill status={d.status} reason={d.status === "returned" ? d.revisions[0]?.reason : null} /> : undefined;
  // Squeezed, a remembered open detail stays folded (the canvas keeps its share) and one opened now floats over the canvas
  const head = (
    <div ref={headRef}>
      <DetailMobileTitle itemKey={record.document.flow} title={shown.title} badge={badge} />
      <DesignBanner
        d={d}
        acts={decision?.acts}
        detail={
          <>
            {decision?.detail}
            {d.status === "proposed" && health ? <OrphanedTraces traces={health.orphanedTraces} revision={d.proposedRevision} /> : null}
          </>
        }
        alert={decision?.alert}
        open={squeezed ? floatOpen : bannerOpen}
        onOpen={(o) => {
          if (!squeezed) setBannerOpen(o);
          setFloatOpen(o);
        }}
        float={squeezed}
        detailRef={detailRef}
      />
      {repins}
      <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="design-tabs" />
    </div>
  );
  return (
    <DetailLayout
      testId="workflow-design-detail"
      dataKey={record.document.flow}
      railCollapsed={tab === "design" && railCollapsed}
      rail={
        <FactsRail testId="design-rail">
          <WorkflowDesignFacts d={d} record={record} shown={shown} shownRevision={shownRevision} template={template} slug={slug} health={health} />
        </FactsRail>
      }
    >
      {tab === "design" ? (
        <div ref={column} className="flex flex-col lg:h-[calc(100dvh-48px)]" data-testid="view-design">
          {head}
          {/* Focus mode lifts this one element over the page, so the canvas keeps its zoom, selection and walk */}
          <div className={cn("relative flex min-h-0 flex-1 flex-col", focus && "fixed inset-0 z-40 bg-app")} data-testid="design-canvas-area" data-focus={focus}>
            <WorkflowCanvas
              doc={{ ...shown, steps: stepsForLayer({ steps: stepsWithRemoved(shown, diff) }, health ?? null, overlay?.layer ?? "planned") }}
              template={template}
              diff={diff}
              health={overlay}
              decision={walkDecision}
              graph={{ projectId, workflowId: record.document.id, revision: shownRevision, against: diff ? d.approvedRevision : null }}
              focus={{ on: focus, onToggle: () => setFocus(!focus) }}
              changes={
                fullDiff
                  ? { on: changes, onToggle: setChanges, label: t("workflows.canvas.changes", { r: d.approvedRevision ?? "" }), title: t("workflows.changesSince", { r: d.approvedRevision ?? "" }) }
                  : null
              }
            />
            {focus ? null : <RailEdge collapsed={railCollapsed} onToggle={() => setRailCollapsed(!railCollapsed)} />}
          </div>
        </div>
      ) : (
        <>
          {head}
          <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("workflows.tab.design")}>
            {tab === "steps" ? <StepsPane shown={shown} template={template} diff={fullDiff} revision={shownRevision} /> : null}
            {tab === "revisions" ? <RevisionsPane d={d} /> : null}
            {tab === "decisions" ? <DecisionsPanel projectId={projectId} scope="workflow" targetRef={record.document.id} /> : null}
            {tab === "memory" ? <ItemMemory projectId={projectId} slug={slug} cites={record.document.flow} /> : null}
          </DetailPane>
        </>
      )}
    </DetailLayout>
  );
}
