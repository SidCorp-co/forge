"use client";

// A requirement's full page: a main column for reading and acting, beside a sticky rail of the
// at-a-glance facts. The column opens on one strip (whose turn, lifecycle step and what is next,
// k/n verified), then seven views by tabs (Overview with what is still unclear, Criteria, Revisions,
// Mockups, Decisions, Memory, Activity); in Revisions, Decisions and Activity the long reading stays
// folded until opened (REQ-35 BC-5, BC-6, BC-7). Each fact and each act appears once: Accept / Reject
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
  FieldLabel,
  ViewHeading,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { EntityCommentThread } from "@/features/comments/components/entity-comment-thread";
import { MockupsPanel } from "@/features/mockups/components/mockups-panel";
import { useMockups } from "@/features/mockups/hooks";
import { PendingBadge, RequirementSuggestions } from "@/features/suggestions/components/suggestion-list";
import { useWaitingSuggestions } from "@/features/suggestions/hooks";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useRequirement, useRequirementDecisions } from "../hooks";
import type { RequirementDetail, RequirementRevision } from "../types";
import { ProposalDecision, ProposeChange } from "./requirement-actions";
import { RequirementFacts } from "./requirement-facts";
import { CriteriaChecklist, History, Readiness, RevisionDiff, RevisionList } from "./requirement-proof";
import { RequirementDecisions } from "./requirement-decisions";
import { RequirementMemory, useRequirementMemoryCount } from "./requirement-memory";
import { AssumptionsSection, UnclearSection } from "./requirement-unclear";
import { RequirementProgress } from "./standing-bits";

const REQUIREMENT_TABS = ["overview", "criteria", "revisions", "mockups", "decisions", "memory", "activity"] as const;
type RequirementTab = (typeof REQUIREMENT_TABS)[number];

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

const NoneNamed = ({ t }: { t: Copy }) => <p className="text-13 text-subtle">{t("requirements.overview.noneNamed")}</p>;

function Overview({ d, projectId, slug }: { d: RequirementDetail; projectId: string; slug: string }) {
  const t = useCopy();
  const shown = d.revisions.find((r) => r.state === "current") ?? d.revisions[0];
  const spec = shown?.spec ?? {};
  const summary = shown?.tldr ?? spec.goal;
  const goalBeyond = shown?.tldr && spec.goal && spec.goal !== shown.tldr ? spec.goal : null;
  const sug = useWaitingSuggestions(projectId, { requirement: d.key });
  const waiting = d.canSignOff && (sug.data?.suggestions.length ?? 0) > 0;
  return (
    <div className="grid gap-8" data-testid="view-overview">
      <section>
        <ViewHeading right={shown ? <span className="text-12 text-subtle">{t("requirements.overview.fromR", { r: shown.revision })}</span> : undefined}>
          {t("requirements.overview.summary")}
        </ViewHeading>
        {summary ? <Written className="block max-w-[80ch] text-15 leading-relaxed text-fg" text={summary} lang={shown?.writtenLang} /> : <p className="text-13 text-subtle">{t("requirements.overview.noSummary")}</p>}
        {goalBeyond ? (
          <details className="mt-2 max-w-[72ch]">
            <summary className="cursor-pointer select-none text-13 font-medium text-muted hover:text-fg">{t("requirements.overview.fullGoal")}</summary>
            <p className="mt-1.5 text-14 leading-relaxed">{goalBeyond}</p>
          </details>
        ) : null}
      </section>
      <UnclearSection questions={d.questions} unclear={d.unclear} projectId={projectId} reqKey={d.key} slug={slug} />
      {spec.assumptions?.length ? <AssumptionsSection assumptions={spec.assumptions} revision={shown?.revision ?? null} /> : null}
      {spec.personas?.length || spec.scopeIn?.length || spec.scopeOut?.length ? (
        <section>
          <ViewHeading>{t("requirements.overview.servesAndScope")}</ViewHeading>
          <div className="grid gap-x-10 gap-y-5 md:grid-cols-2">
            <div>
              <FieldLabel>{t("requirements.overview.persona")}</FieldLabel>
              {spec.personas?.length ? <Bullets items={spec.personas} /> : <NoneNamed t={t} />}
            </div>
            <div className="grid content-start gap-5">
              <div>
                <FieldLabel>{t("requirements.overview.inScope")}</FieldLabel>
                {spec.scopeIn?.length ? <Bullets items={spec.scopeIn} /> : <NoneNamed t={t} />}
              </div>
              <div>
                <FieldLabel>{t("requirements.overview.outOfScope")}</FieldLabel>
                {spec.scopeOut?.length ? <Bullets items={spec.scopeOut} /> : <NoneNamed t={t} />}
              </div>
            </div>
          </div>
        </section>
      ) : null}
      {waiting ? (
        <section>
          <ViewHeading>{t("requirements.overview.suggestionsWaiting")}</ViewHeading>
          <RequirementSuggestions projectId={projectId} reqKey={d.key} />
        </section>
      ) : null}
    </div>
  );
}

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
    <section id="proposal" className="border-l-[3px] py-1 pl-4" style={{ borderColor: AGENT_TINT.dot }} data-testid="open-revision">
      <ViewHeading
        right={
          <span className="inline-flex items-center gap-2 text-12-5 text-muted">
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
      <Written className="block max-w-[80ch] text-14 leading-relaxed" text={open.changeSummary ?? open.reason} lang={open.writtenLang} />
      {open.changeSummary && open.reason !== open.changeSummary ? <p className="mt-1.5 max-w-[80ch] text-13 text-muted">{t("requirements.revision.why", { reason: open.reason })}</p> : null}
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
                <RequirementFacts d={d} slug={slug} onOpenRevisions={() => onTab("revisions")} projectId={projectId} />
              </FactsRail>
            }
          >
            <DetailMobileTitle itemKey={d.key} title={d.title} badge={<StatusBadge family="requirement" value={s.state} />} />
            {/* the strip stays first; a picture (ISS-460) goes between it and the tabs */}
            <RequirementProgress standing={s} slug={slug} inset="px-8 max-md:px-4" />
            <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="requirement-tabs" />
            <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("requirements.tab.overview")}>
              {tab === "overview" ? <Overview d={d} projectId={projectId} slug={slug} /> : null}
              {tab === "criteria" ? <Criteria d={d} projectId={projectId} slug={slug} /> : null}
              {tab === "revisions" ? <Revisions d={d} projectId={projectId} /> : null}
              {tab === "mockups" ? <MockupsPanel projectId={projectId} target={mockupTarget} /> : null}
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
