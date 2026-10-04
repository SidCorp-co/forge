"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  type BannerTone,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  FactsRail,
  StatusBadge,
  Toggle,
  useUrlTab,
  ViewHeading,
  WaitBanner,
} from "@/design";
import { DecisionsPanel } from "@/features/comments/components/decisions-panel";
import { formatRelativeTime, formatStamp } from "@/lib/utils/format";
import { readCanvas, titleOf } from "../canvas/model";
import { WorkflowCanvas } from "../canvas/workflow-canvas";
import { type DesignDiff, designDiff, stepsWithRemoved } from "../design-diff";
import type { WorkflowBody, WorkflowDesign, WorkflowRecord, WorkflowStep } from "../types";
import { WorkflowDesignFacts } from "./workflow-design-facts";
import { DesignPill } from "./workflow-parts";

export const DESIGN_TABS = ["design", "steps", "revisions", "decisions"] as const;
export type DesignTab = (typeof DESIGN_TABS)[number];

export const useDesignTab = () => useUrlTab(DESIGN_TABS);

const BANNER_TONE: Record<WorkflowDesign["waitingOn"]["kind"], BannerTone> = {
  you: "you",
  person: "calm",
  agent: "agent",
  none: "calm",
};

const waitHead = (w: WorkflowDesign["waitingOn"]) => (w.kind === "you" ? "Waiting on you:" : `Waiting on ${w.who}:`);

export function DesignBanner({ d, children, className }: { d: WorkflowDesign; children?: ReactNode; className?: string }) {
  const w = d.waitingOn;
  if (w.kind === "none") return null;
  const latest = d.revisions[0];
  return (
    <WaitBanner tone={BANNER_TONE[w.kind]} head={waitHead(w)} body={w.act} rule={w.rule} className={className} testId="design-banner">
      {latest && d.status === "returned" && latest.reason ? (
        <span className="line-clamp-2 text-12-5 text-muted" title={latest.reason}>
          {latest.reason}
        </span>
      ) : null}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {latest && d.status === "proposed" ? (
          <span className="text-12-5 text-muted" title={formatStamp(latest.proposedAt)}>
            Proposed by {latest.proposedByName ?? latest.proposedBy} · {formatRelativeTime(latest.proposedAt)}
          </span>
        ) : null}
        {children}
      </span>
    </WaitBanner>
  );
}

const MARK: Record<string, string> = { added: "Added", changed: "Changed", removed: "Removed" };

function StepRows({ steps, numbered, diff, revision }: { steps: WorkflowStep[]; numbered: Map<string, number>; diff: DesignDiff | null; revision: number }) {
  return (
    <ul>
      {steps.map((s) => {
        const mark = diff?.steps.get(s.id);
        return (
          <li key={s.id} className="grid grid-cols-[36px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)] items-baseline gap-x-3 border-b border-line-subtle px-3 py-2.5 text-13 max-md:grid-cols-[28px_minmax(0,1fr)]" data-testid="design-step-row" data-mark={mark}>
            <span className="font-mono text-12 text-subtle">{numbered.get(s.id) ?? ""}</span>
            <span className="min-w-0">
              <span className="font-medium" title={s.node?.purpose ?? s.does}>
                {titleOf(s)}
              </span>
              {mark ? (
                <span className="ml-2 text-12 font-semibold text-accent-text" title={`Against the approved revision, revision ${revision} ${mark} this step`}>
                  {MARK[mark]} in rev {revision}
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
  const c = readCanvas(shown, template);
  const numbered = new Map(shown.steps.map((s, i) => [s.id, i + 1]));
  const groups = c.bands.length > 0 ? c.bands.map((b) => ({ id: b.id, label: b.label, steps: b.steps.flatMap((id) => c.steps.get(id) ?? []) })) : [{ id: "all", label: "", steps: shown.steps }];
  const unit = shown.kind === "state" ? "State" : "Step";
  return (
    <div data-testid="view-steps">
      <ViewHeading>Who owns what</ViewHeading>
      <div className="grid h-8 grid-cols-[36px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)] items-center gap-x-3 border-y border-line-subtle bg-sunken px-3 text-11-5 font-semibold text-subtle max-md:hidden" aria-hidden>
        <span>#</span>
        <span>{unit}</span>
        <span>Owner</span>
        <span>Deadline</span>
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

function RevisionsPane({ d }: { d: WorkflowDesign }) {
  return (
    <div data-testid="view-revisions">
      <ViewHeading right={<span className="text-12 text-subtle">Newest first</span>}>Revisions</ViewHeading>
      {d.revisions.length === 0 ? (
        <p className="text-13 text-subtle">No revision has been proposed; the design is read as written.</p>
      ) : (
        <ul className="border-t border-line-subtle">
          {d.revisions.map((r) => (
            <li key={r.revision} className="grid grid-cols-[72px_150px_minmax(0,1fr)] items-baseline gap-x-3 border-b border-line-subtle px-3 py-2.5 text-13 max-md:grid-cols-[56px_minmax(0,1fr)]" data-testid="revision-row">
              <span className="font-mono text-12-5 font-semibold">r{r.revision}</span>
              <span>
                <StatusBadge family="designRevision" value={r.state} />
              </span>
              <span className="min-w-0 text-muted max-md:col-start-2">
                <span title={formatStamp(r.proposedAt)}>
                  Proposed by {r.proposedByName ?? r.proposedBy} · {formatRelativeTime(r.proposedAt)}
                </span>
                {r.decidedAt ? (
                  <span title={formatStamp(r.decidedAt)}>
                    {" "}
                    · {r.decision === "return" ? "returned" : "approved"}
                    {r.decidedByName ? ` by ${r.decidedByName}` : ""}
                  </span>
                ) : null}
                {r.reason ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer select-none text-12-5 font-medium text-muted hover:text-fg">Reason</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words text-12-5 text-fg">{r.reason}</p>
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

export interface DesignPageProps {
  projectId: string;
  slug: string;
  d: WorkflowDesign;
  record: WorkflowRecord;
  template: WorkflowTemplate | null;
  decisionCount?: number;
  tab: DesignTab;
  onTab: (t: DesignTab) => void;
  returnControl?: ReactNode;
  walkDecision?: ReactNode;
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

export function WorkflowDesignPage({ projectId, slug, d, record, template, decisionCount, tab, onTab, returnControl, walkDecision }: DesignPageProps) {
  const [changes, setChanges] = useState(false);
  const { shown, shownRevision, approved } = shownDesign(d, record);
  const fullDiff = approved ? designDiff(approved, shown, template) : null;
  const diff = changes ? fullDiff : null;
  const tabs = [
    { value: "design" as const, label: "Design" },
    { value: "steps" as const, label: shown.kind === "state" ? "States" : "Steps", count: shown.steps.length },
    { value: "revisions" as const, label: "Revisions", count: d.revisions.length },
    { value: "decisions" as const, label: "Decisions", ...(decisionCount !== undefined ? { count: decisionCount } : {}) },
  ];
  const badge = d.status ? <DesignPill status={d.status} reason={d.status === "returned" ? d.revisions[0]?.reason : null} /> : undefined;
  const head = (
    <>
      <DetailMobileTitle itemKey={record.document.flow} title={shown.title} badge={badge} />
      <DesignBanner d={d} className="px-6 py-2.5 max-md:px-4">
        {returnControl}
      </DesignBanner>
      <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="design-tabs" />
    </>
  );
  return (
    <DetailLayout
      testId="workflow-design-detail"
      dataKey={record.document.flow}
      rail={
        <FactsRail testId="design-rail">
          <WorkflowDesignFacts d={d} record={record} shown={shown} shownRevision={shownRevision} template={template} slug={slug} />
        </FactsRail>
      }
    >
      {tab === "design" ? (
        <div className="flex flex-col lg:h-[calc(100dvh-48px)]" data-testid="view-design">
          {head}
          {fullDiff ? (
            <div className="flex items-center gap-2 border-b border-line-subtle bg-surface px-6 py-1.5 text-12-5 font-semibold max-md:px-4" title={`Against approved r${d.approvedRevision}`}>
              <Toggle checked={changes} onChange={setChanges} aria-label="Changes since approved" />
              Changes since approved rev {d.approvedRevision}
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col">
            <WorkflowCanvas doc={{ ...shown, steps: stepsWithRemoved(shown, diff) }} template={template} diff={diff} decision={walkDecision} />
          </div>
        </div>
      ) : (
        <>
          {head}
          <DetailPane label={tabs.find((t) => t.value === tab)?.label ?? "Design"}>
            {tab === "steps" ? <StepsPane shown={shown} template={template} diff={fullDiff} revision={shownRevision} /> : null}
            {tab === "revisions" ? <RevisionsPane d={d} /> : null}
            {tab === "decisions" ? <DecisionsPanel projectId={projectId} scope="workflow" targetRef={record.document.id} /> : null}
          </DetailPane>
        </>
      )}
    </DetailLayout>
  );
}
