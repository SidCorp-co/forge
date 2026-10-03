"use client";

// A requirement's full page: a main column for reading and acting, split into four views by tabs
// (Overview, Criteria, Revisions, Activity), beside a sticky rail of the at-a-glance facts. Each
// fact and each act appears once: the facts live in the rail, Accept / Reject only beside the diff.
// Everything derived (whose turn, coverage, history) comes from core's read model.

import {
  ActorChip,
  AGENT_TINT,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  ErrorState,
  FactsRail,
  ProjectLoader,
  StatusBadge,
  useUrlTab,
} from "@/design";
import { PendingBadge, RequirementSuggestions } from "@/features/suggestions/components/suggestion-list";
import { useWaitingSuggestions } from "@/features/suggestions/hooks";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { formatRelativeTime, formatStamp as stamp } from "@/lib/utils/format";
import { useRequirement } from "../hooks";
import type { RequirementDetail, RequirementRevision } from "../types";
import { ProposalDecision, ProposeChange } from "./requirement-actions";
import { RequirementFacts } from "./requirement-facts";
import { CriteriaTable, FieldLabel, History, Readiness, RevisionDiff, RevisionList, ViewHeading } from "./requirement-proof";
import { RequirementBanner } from "./standing-bits";

export const REQUIREMENT_TABS = ["overview", "criteria", "revisions", "activity"] as const;
export type RequirementTab = (typeof REQUIREMENT_TABS)[number];

/** The open view rides `?tab=`, written without a navigation, so back from an issue lands on it. */
export const useRequirementTab = () => useUrlTab(REQUIREMENT_TABS);

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="grid list-disc gap-1 pl-[18px] text-14 leading-relaxed marker:text-[var(--paper-400)]">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

function Overview({ d, projectId }: { d: RequirementDetail; projectId: string }) {
  const shown = d.revisions.find((r) => r.state === "current") ?? d.revisions[0];
  const spec = shown?.spec ?? {};
  const summary = shown?.tldr ?? spec.goal;
  const goalBeyond = shown?.tldr && spec.goal && spec.goal !== shown.tldr ? spec.goal : null;
  const sug = useWaitingSuggestions(projectId, d.key);
  const waiting = d.canSignOff && (sug.data?.suggestions.length ?? 0) > 0;
  return (
    <div className="grid gap-8" data-testid="view-overview">
      <section>
        <ViewHeading right={shown ? <span className="text-12 text-subtle">From r{shown.revision}</span> : undefined}>Summary</ViewHeading>
        {summary ? <p className="max-w-[80ch] text-15 leading-relaxed text-fg">{summary}</p> : <p className="text-13 text-subtle">No summary written yet.</p>}
        {goalBeyond ? (
          <details className="mt-2 max-w-[72ch]">
            <summary className="cursor-pointer select-none text-13 font-medium text-muted hover:text-fg">Full goal and problem</summary>
            <p className="mt-1.5 text-14 leading-relaxed">{goalBeyond}</p>
          </details>
        ) : null}
      </section>
      {spec.personas?.length || spec.scopeIn?.length || spec.scopeOut?.length ? (
        <section>
          <ViewHeading>Who it serves and its scope</ViewHeading>
          <div className="grid gap-x-10 gap-y-5 md:grid-cols-2">
            <div>
              <FieldLabel>Persona</FieldLabel>
              {spec.personas?.length ? <Bullets items={spec.personas} /> : <p className="text-13 text-subtle">None named.</p>}
            </div>
            <div className="grid content-start gap-5">
              <div>
                <FieldLabel>In scope</FieldLabel>
                {spec.scopeIn?.length ? <Bullets items={spec.scopeIn} /> : <p className="text-13 text-subtle">None named.</p>}
              </div>
              <div>
                <FieldLabel>Out of scope</FieldLabel>
                {spec.scopeOut?.length ? <Bullets items={spec.scopeOut} /> : <p className="text-13 text-subtle">None named.</p>}
              </div>
            </div>
          </div>
        </section>
      ) : null}
      {waiting ? (
        <section>
          <ViewHeading>Suggestions waiting on you</ViewHeading>
          <RequirementSuggestions projectId={projectId} reqKey={d.key} />
        </section>
      ) : null}
    </div>
  );
}

function Criteria({ d, projectId, slug }: { d: RequirementDetail; projectId: string; slug: string }) {
  const sug = useWaitingSuggestions(projectId, d.key);
  const f = d.standing.facts;
  return (
    <section data-testid="view-criteria">
      <ViewHeading>Business criteria</ViewHeading>
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-muted">
        <span>
          Passing <b className="font-semibold text-fg">{f.passing} of {f.criteria}</b>
        </span>
        <span aria-hidden>·</span>
        <Readiness suggestions={sug.data?.suggestions ?? []} />
        {d.standing.shownRevision !== null ? (
          <>
            <span aria-hidden>·</span>
            <span>Wording of r{d.standing.shownRevision}</span>
          </>
        ) : null}
      </div>
      <CriteriaTable d={d} slug={slug} />
    </section>
  );
}

function OpenRevision({ d, projectId, open }: { d: RequirementDetail; projectId: string; open: RequirementRevision }) {
  const base = d.revisions.find((r) => r.revision === (open.baseRevision ?? d.currentRevision ?? -1)) ?? d.revisions.find((r) => r.state === "current");
  const proposed = open.state === "proposed";
  const at = open.proposedAt ?? open.createdAt;
  return (
    <section id="proposal" className="border-l-[3px] py-1 pl-4" style={{ borderColor: AGENT_TINT.dot }} data-testid="open-revision">
      <ViewHeading
        right={
          <span className="inline-flex items-center gap-2 text-12-5 text-muted">
            <ActorChip name={open.authorName ?? "Its author"} kind={open.authorKind} />
            <span title={`${proposed ? "Proposed" : "Written"} ${stamp(at)}`}>{formatRelativeTime(at)}</span>
          </span>
        }
      >
        <span className="inline-flex items-center gap-2">
          {proposed ? "Proposal" : "Draft"} r{open.revision}
          {proposed ? <PendingBadge /> : null}
        </span>
      </ViewHeading>
      <p className="max-w-[80ch] text-14 leading-relaxed">{open.changeSummary ?? open.reason}</p>
      {open.changeSummary && open.reason !== open.changeSummary ? <p className="mt-1.5 max-w-[80ch] text-13 text-muted">Why: {open.reason}</p> : null}
      <div className="mt-3">
        <FieldLabel>Changes against r{base?.revision ?? "—"}</FieldLabel>
        <RevisionDiff base={base} next={open} />
      </div>
      {proposed ? (
        <div className="mt-4">
          <ProposalDecision projectId={projectId} d={d} revision={open.revision} />
        </div>
      ) : null}
    </section>
  );
}

function Revisions({ d, projectId }: { d: RequirementDetail; projectId: string }) {
  const open = d.revisions.find((r) => r.state === "proposed" || r.state === "draft");
  return (
    <div className="grid gap-8" data-testid="view-revisions">
      {open ? <OpenRevision d={d} projectId={projectId} open={open} /> : null}
      <section>
        <ViewHeading right={d.standing.attentionGroup !== "done" ? <ProposeChange projectId={projectId} reqKey={d.key} /> : undefined}>
          All revisions
        </ViewHeading>
        <RevisionList d={d} />
      </section>
    </div>
  );
}

export function RequirementPage({
  projectId,
  slug,
  reqKey,
  tab,
  onTab,
}: {
  projectId: string;
  slug: string;
  reqKey: string;
  tab: RequirementTab;
  onTab: (t: RequirementTab) => void;
}) {
  const q = useRequirement(projectId, reqKey);
  if (q.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ProjectLoader label="loading requirement…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
      </div>
    );
  }
  const d = q.data;
  const s = d.standing;
  const banner = s.waitingOn.kind === "you" || (s.attentionGroup === "stuck" && s.waitingOn.kind === "none");
  const tabs = [
    { value: "overview" as const, label: "Overview" },
    { value: "criteria" as const, label: "Criteria", count: s.coverage.length },
    { value: "revisions" as const, label: "Revisions", count: d.revisions.length },
    { value: "activity" as const, label: "Activity", count: d.history.length },
  ];
  return (
    <DetailLayout
      testId="requirement-detail"
      dataKey={d.key}
      rail={
        <FactsRail testId="relations-rail">
          <RequirementFacts d={d} projectId={projectId} slug={slug} onOpenRevisions={() => onTab("revisions")} />
        </FactsRail>
      }
    >
      <DetailMobileTitle itemKey={d.key} title={d.title} badge={<StatusBadge family="requirement" value={s.state} />} />
      {banner ? <RequirementBanner standing={s} className="px-8 py-2.5 max-md:px-4" /> : null}
      <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="requirement-tabs" />
      <DetailPane label={tabs.find((t) => t.value === tab)?.label ?? "Overview"}>
        {tab === "overview" ? <Overview d={d} projectId={projectId} /> : null}
        {tab === "criteria" ? <Criteria d={d} projectId={projectId} slug={slug} /> : null}
        {tab === "revisions" ? <Revisions d={d} projectId={projectId} /> : null}
        {tab === "activity" ? (
          <section data-testid="view-activity" aria-label="Activity">
            <History entries={d.history} />
          </section>
        ) : null}
      </DetailPane>
    </DetailLayout>
  );
}
