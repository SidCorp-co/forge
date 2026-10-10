"use client";

// A requirement's full page: a main column for reading and acting, beside a sticky rail of the
// at-a-glance facts. The column opens on one strip (whose turn, where it stands on the lifecycle and
// what is next, k/n verified), then the requirement's picture above any text (REQ-35 BC-1,
// `requirement-picture.tsx`), then its views by tabs (Overview with what is still unclear in
// `requirement-overview.tsx`, Criteria, Revisions, Mockups, Activity, and Memory in the developer
// view). Revisions holds the open one and the act that proposes the next; the revisions that stood
// before and the decisions taken are past items, read folded under Activity (REQ-35 BC-7, REQ-43
// BC-8). Each fact and each act appears once: Accept / Reject only beside the diff; a count is said
// once, so no tab counts what its view counts (BC-5). A person's view leaves the agent text out —
// criterion codes, revision numbers, the assistant's draft, agent memory — and `?view=developer`
// draws it (BC-7). Everything derived (whose turn, coverage, history) comes from core's read model.

import { Written } from "@/lib/i18n/written";
import {
  ActorChip,
  AGENT_TINT,
  Disclosure,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  FactsRail,
  type RecordView,
  RecordViewSwitch,
  StatusBadge,
  useRecordView,
  useUrlTab,
  ViewHeading,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { EntityCommentThread } from "@/features/comments";
import { MockupList } from "@/features/mockups";
import { useMockups } from "@/features/mockups";
import { PendingBadge } from "@/features/suggestions";
import { useWaitingSuggestions } from "@/features/suggestions";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useRequirement } from "../hooks";
import type { RequirementDetail, RequirementRevision } from "../types";
import { ProposalDecision, ProposeChange } from "./requirement-actions";
import { RequirementProperties } from "./requirement-facts";
import { CriteriaChanges, CriteriaChecklist, History, Readiness, RevisionDiff, RevisionList } from "./requirement-proof";
import { RequirementDecisions } from "./requirement-decisions";
import { RequirementMemory, useRequirementMemoryCount } from "./requirement-memory";
import { RequirementOverview } from "./requirement-overview";
import { RequirementPicture } from "./requirement-picture";
import { RequirementProgress } from "./standing-bits";

const REQUIREMENT_TABS = ["overview", "criteria", "revisions", "mockups", "activity", "memory"] as const;
type RequirementTab = (typeof REQUIREMENT_TABS)[number];

/** The open view rides `?tab=`, written without a navigation, so back from an issue lands on it. */
export const useRequirementTab = () => useUrlTab(REQUIREMENT_TABS);

/**
 * The criteria as a checklist under their verdict pills. "k/n verified" is the strip's, above the tabs,
 * so the view does not say it again; the developer view adds the assistant's readiness advice and the
 * revision the wording is read at.
 */
function Criteria({ d, projectId, slug, developer }: { d: RequirementDetail; projectId: string; slug: string; developer: boolean }) {
  const t = useCopy();
  const sug = useWaitingSuggestions(developer ? projectId : undefined, { requirement: d.key });
  return (
    <section data-testid="view-criteria">
      <ViewHeading>{t("requirements.criteria.heading")}</ViewHeading>
      {developer ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-muted" data-testid="criteria-developer">
          {d.standing.shownRevision !== null ? <span>{t("requirements.criteria.wordingOf", { r: d.standing.shownRevision })}</span> : null}
          <Readiness suggestions={sug.data?.suggestions ?? []} />
        </div>
      ) : null}
      <CriteriaChecklist d={d} slug={slug} developer={developer} />
    </section>
  );
}

function OpenRevision({ d, projectId, open }: { d: RequirementDetail; projectId: string; open: RequirementRevision }) {
  const t = useCopy();
  const time = useTimeFormat();
  const base = d.revisions.find((r) => r.revision === (open.baseRevision ?? d.currentRevision ?? -1)) ?? d.revisions.find((r) => r.state === "current");
  const proposed = open.state === "proposed";
  const at = open.proposedAt ?? open.createdAt;
  return (
    <section id="proposal" className="border-l-3 py-1 pl-4" style={{ borderColor: AGENT_TINT.dot }} data-testid="open-revision">
      <ViewHeading
        right={
          <span className="inline-flex items-center gap-2 text-13 text-muted">
            <ActorChip name={open.authorName ?? t("standing.who.itsAuthor")} kind={open.authorKind} />
            <span title={t(proposed ? "requirements.revision.proposedAt" : "requirements.revision.writtenAt", { at: time.dateTime(at) })}>{time.relative(at)}</span>
          </span>
        }
      >
        <span className="inline-flex items-center gap-2">
          {t(proposed ? "requirements.revision.proposal" : "requirements.revision.draft", { r: open.revision })}
          {proposed ? <PendingBadge /> : null}
        </span>
      </ViewHeading>
      <Written className="block max-w-2xl text-14 leading-relaxed" text={open.changeSummary ?? open.reason} lang={open.writtenLang} />
      {open.changeSummary && open.reason && open.reason !== open.changeSummary ? <p className="mt-1.5 max-w-2xl text-13 text-muted">{t("requirements.revision.why", { reason: open.reason })}</p> : null}
      <div className="mt-1.5">
        <CriteriaChanges changes={open.criteriaChanges} />
      </div>
      <div className="mt-3" data-testid="open-revision-diff">
        <Disclosure title={t("requirements.revision.changesAgainst", { r: base?.revision ?? "—" })}>
          <RevisionDiff base={base} next={open} />
        </Disclosure>
      </div>
      {proposed ? (
        <div className="mt-4">
          <ProposalDecision projectId={projectId} d={d} revision={open.revision} />
        </div>
      ) : null}
    </section>
  );
}

/** The open revision, and the act that proposes the next; the revisions that stood before are Activity's. */
function Revisions({ d, projectId }: { d: RequirementDetail; projectId: string }) {
  const t = useCopy();
  const open = d.revisions.find((r) => r.state === "proposed" || r.state === "draft");
  const canPropose = d.standing.attentionGroup !== "done";
  return (
    <div className="grid gap-8" data-testid="view-revisions">
      {open ? <OpenRevision d={d} projectId={projectId} open={open} /> : null}
      {canPropose ? (
        <div className="flex justify-end" data-testid="revision-propose">
          <ProposeChange projectId={projectId} reqKey={d.key} />
        </div>
      ) : null}
      {!open && !canPropose ? <p className="text-13 text-subtle">{t("requirements.revision.noneOpen")}</p> : null}
    </div>
  );
}

/**
 * The Activity view: the requirement's comments, where a person asks, notes or records a decision on
 * it; its history of revisions and sign-offs; every revision; and the decisions taken on it. These are
 * the past items (REQ-43 BC-8), each folded until opened; a thread is read only once its fold opens.
 */
function RequirementActivity({ projectId, slug, d }: { projectId: string; slug: string; d: RequirementDetail }) {
  const t = useCopy();
  return (
    <section data-testid="view-activity" aria-label={t("requirements.tab.activity")}>
      <Disclosure title={t("requirements.activity.comments")}>
        <EntityCommentThread projectId={projectId} scope="requirement" targetRef={d.key} />
      </Disclosure>
      <div className="-mt-px">
        <Disclosure title={t("requirements.activity.history")} count={d.history.length}>
          <History entries={d.history} />
        </Disclosure>
      </div>
      <div className="-mt-px" data-testid="revision-fold">
        <Disclosure title={t("requirements.revision.all")} count={d.revisions.length}>
          <RevisionList d={d} />
        </Disclosure>
      </div>
      {/* the decisions fold themselves, by decisions and answers, beside the composer that records one */}
      <div className="mt-6" data-testid="view-decisions">
        <RequirementDecisions key={d.key} projectId={projectId} slug={slug} reqKey={d.key} />
      </div>
    </section>
  );
}

/** The person / developer switch, at the right above the tabs. */
function ViewBar({ view, onView }: { view: RecordView; onView: (v: RecordView) => void }) {
  return (
    <div className="flex justify-end px-8 pt-3 max-md:px-4" data-testid="requirement-view-bar">
      <RecordViewSwitch view={view} onView={onView} />
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
  const t = useCopy();
  const [view, onView] = useRecordView();
  const developer = view === "developer";
  const q = useRequirement(projectId, reqKey);
  const memories = useRequirementMemoryCount(projectId, reqKey);
  const proposedAt =
    q.data?.revisions.find((r) => r.state === "draft" || r.state === "proposed")?.revision ??
    q.data?.currentRevision ??
    q.data?.revisions[0]?.revision ??
    1;
  const mockupTarget = { type: "requirement" as const, key: reqKey, revision: proposedAt };
  const mockups = useMockups(projectId, mockupTarget);
  return (
    <QueryBoundary query={q} loadingLabel={t("requirements.loadingOne")}>
      {(data) => {
        const d = data;
        const s = d.standing;
        const tabs = [
          { value: "overview" as const, label: t("requirements.tab.overview"), count: d.unclear || undefined },
          { value: "criteria" as const, label: t("requirements.tab.criteria") },
          { value: "revisions" as const, label: t("requirements.tab.revisions") },
          { value: "mockups" as const, label: t("requirements.tab.mockups"), count: mockups.data?.returned },
          { value: "activity" as const, label: t("requirements.tab.activity") },
          ...(developer ? [{ value: "memory" as const, label: t("memory.title"), count: memories }] : []),
        ];
        // memory is the developer view's: a person's view reading ?tab=memory opens on the Overview
        const shownTab = tabs.some((x) => x.value === tab) ? tab : "overview";
        return (
          <DetailLayout
            testId="requirement-detail"
            dataKey={d.key}
            rail={
              <FactsRail testId="relations-rail">
                <RequirementProperties d={d} slug={slug} onOpenRevisions={() => onTab("revisions")} projectId={projectId} developer={developer} />
              </FactsRail>
            }
          >
            <DetailMobileTitle itemKey={d.key} title={d.title} badge={<StatusBadge family="requirement" value={s.state} />} />
            <RequirementProgress standing={s} slug={slug} inset="px-8 max-md:px-4" />
            <RequirementPicture d={d} projectId={projectId} slug={slug} inset="px-8 max-md:px-4" />
            <ViewBar view={view} onView={onView} />
            <DetailTabs tabs={tabs} value={shownTab} onChange={onTab} testId="requirement-tabs" />
            <DetailPane label={tabs.find((x) => x.value === shownTab)?.label ?? t("requirements.tab.overview")}>
              {shownTab === "overview" ? <RequirementOverview d={d} projectId={projectId} slug={slug} onRevise={() => onTab("revisions")} developer={developer} /> : null}
              {shownTab === "criteria" ? <Criteria d={d} projectId={projectId} slug={slug} developer={developer} /> : null}
              {shownTab === "revisions" ? <Revisions d={d} projectId={projectId} /> : null}
              {shownTab === "mockups" ? <MockupList projectId={projectId} target={mockupTarget} /> : null}
              {shownTab === "memory" ? <RequirementMemory projectId={projectId} slug={slug} reqKey={d.key} /> : null}
              {shownTab === "activity" ? <RequirementActivity projectId={projectId} slug={slug} d={d} /> : null}
            </DetailPane>
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}
