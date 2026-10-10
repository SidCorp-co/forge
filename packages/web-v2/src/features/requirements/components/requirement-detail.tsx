"use client";

// A requirement's full page: a main column for reading and acting, beside a sticky rail of the
// at-a-glance facts. The column opens on one strip (whose turn, lifecycle step and what is next,
// k/n verified), then the requirement's picture above any text (REQ-35 BC-1, `requirement-picture.tsx`),
// then seven views by tabs (Overview with what is still unclear in `requirement-overview.tsx`,
// Criteria, Revisions, Mockups, Decisions, Memory, Activity); in Revisions, Decisions and Activity
// the long reading stays folded until opened (REQ-35 BC-5, BC-6, BC-7). Each fact and each act appears once: Accept / Reject
// only beside the diff. Everything derived (whose turn, coverage, history) comes from core's read model.

import { Written } from "@/lib/i18n/written";
import { criteriaCoverageOf } from "@forge/contracts/requirements";
import {
  ActorChip,
  AGENT_TINT,
  Collapsible,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  FactsRail,
  StatusBadge,
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
import { useRequirement, useRequirementDecisions } from "../hooks";
import type { RequirementDetail, RequirementRevision } from "../types";
import { ProposalDecision, ProposeChange } from "./requirement-actions";
import { RequirementProperties } from "./requirement-facts";
import { CriteriaChanges, CriteriaChecklist, History, Readiness, RevisionDiff, RevisionList } from "./requirement-proof";
import { RequirementDecisions } from "./requirement-decisions";
import { RequirementMemory, useRequirementMemoryCount } from "./requirement-memory";
import { RequirementOverview } from "./requirement-overview";
import { RequirementPicture } from "./requirement-picture";
import { RequirementProgress } from "./standing-bits";

const REQUIREMENT_TABS = ["overview", "criteria", "revisions", "mockups", "decisions", "memory", "activity"] as const;
type RequirementTab = (typeof REQUIREMENT_TABS)[number];

/** The open view rides `?tab=`, written without a navigation, so back from an issue lands on it. */
export const useRequirementTab = () => useUrlTab(REQUIREMENT_TABS);

function Criteria({ d, projectId, slug }: { d: RequirementDetail; projectId: string; slug: string }) {
  const t = useCopy();
  const sug = useWaitingSuggestions(projectId, { requirement: d.key });
  // "k/n verified" is the one count core's standing, the delivery rollup and a release's bar read
  const { passing: k, criteria: n } = criteriaCoverageOf(d.standing.coverage);
  return (
    <section data-testid="view-criteria">
      <ViewHeading>{t("requirements.criteria.heading")}</ViewHeading>
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-muted">
        <b className="font-semibold text-fg" data-testid="criteria-verified">
          {t("requirements.verified", { a: k, b: n })}
        </b>
        <Readiness suggestions={sug.data?.suggestions ?? []} />
        {d.standing.shownRevision !== null ? (
          <>
            <span aria-hidden>·</span>
            <span>{t("requirements.criteria.wordingOf", { r: d.standing.shownRevision })}</span>
          </>
        ) : null}
      </div>
      <CriteriaChecklist d={d} slug={slug} />
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
        <Collapsible title={t("requirements.revision.changesAgainst", { r: base?.revision ?? "—" })}>
          <RevisionDiff base={base} next={open} />
        </Collapsible>
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
  const t = useCopy();
  const open = d.revisions.find((r) => r.state === "proposed" || r.state === "draft");
  return (
    <div className="grid gap-8" data-testid="view-revisions">
      {open ? <OpenRevision d={d} projectId={projectId} open={open} /> : null}
      <section data-testid="revision-fold">
        {d.standing.attentionGroup !== "done" ? (
          <div className="mb-2 flex justify-end">
            <ProposeChange projectId={projectId} reqKey={d.key} />
          </div>
        ) : null}
        <Collapsible title={t("requirements.revision.all")} count={d.revisions.length}>
          <RevisionList d={d} />
        </Collapsible>
      </section>
    </div>
  );
}

/**
 * The Activity view: the requirement's comments, where a person asks, notes or records a decision
 * on it, and its history of revisions and sign-offs, each folded until opened; the thread is read
 * only once its fold opens.
 */
function RequirementActivity({ projectId, d }: { projectId: string; d: RequirementDetail }) {
  const t = useCopy();
  return (
    <section data-testid="view-activity" aria-label={t("requirements.tab.activity")}>
      <Collapsible title={t("requirements.activity.comments")}>
        <EntityCommentThread projectId={projectId} scope="requirement" targetRef={d.key} />
      </Collapsible>
      <div className="-mt-px">
        <Collapsible title={t("requirements.activity.history")} count={d.history.length}>
          <History entries={d.history} />
        </Collapsible>
      </div>
    </section>
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
  const q = useRequirement(projectId, reqKey);
  const decisions = useRequirementDecisions(projectId, reqKey);
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
          { value: "criteria" as const, label: t("requirements.tab.criteria"), count: s.coverage.length },
          { value: "revisions" as const, label: t("requirements.tab.revisions"), count: d.revisions.length },
          { value: "mockups" as const, label: t("requirements.tab.mockups"), count: mockups.data?.returned },
          { value: "decisions" as const, label: t("requirements.tab.decisions"), count: decisions.data ? decisions.data.decisions.length + decisions.data.answers.length : undefined },
          { value: "memory" as const, label: t("memory.title"), count: memories },
          { value: "activity" as const, label: t("requirements.tab.activity"), count: d.history.length },
        ];
        return (
          <DetailLayout
            testId="requirement-detail"
            dataKey={d.key}
            rail={
              <FactsRail testId="relations-rail">
                <RequirementProperties d={d} slug={slug} onOpenRevisions={() => onTab("revisions")} projectId={projectId} />
              </FactsRail>
            }
          >
            <DetailMobileTitle itemKey={d.key} title={d.title} badge={<StatusBadge family="requirement" value={s.state} />} />
            <RequirementProgress standing={s} slug={slug} inset="px-8 max-md:px-4" />
            <RequirementPicture d={d} projectId={projectId} slug={slug} inset="px-8 max-md:px-4" />
            <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="requirement-tabs" />
            <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("requirements.tab.overview")}>
              {tab === "overview" ? <RequirementOverview d={d} projectId={projectId} slug={slug} onRevise={() => onTab("revisions")} /> : null}
              {tab === "criteria" ? <Criteria d={d} projectId={projectId} slug={slug} /> : null}
              {tab === "revisions" ? <Revisions d={d} projectId={projectId} /> : null}
              {tab === "mockups" ? <MockupList projectId={projectId} target={mockupTarget} /> : null}
              {tab === "decisions" ? (
                <section data-testid="view-decisions" aria-label={t("requirements.tab.decisions")}>
                  <RequirementDecisions key={d.key} projectId={projectId} slug={slug} reqKey={d.key} />
                </section>
              ) : null}
              {tab === "memory" ? <RequirementMemory projectId={projectId} slug={slug} reqKey={d.key} /> : null}
              {tab === "activity" ? <RequirementActivity projectId={projectId} d={d} /> : null}
            </DetailPane>
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}
