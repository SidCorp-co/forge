"use client";

// A requirement's full page: a main column for reading and acting, split into seven views by tabs
// (Overview with what is still unclear, Criteria, Revisions, Mockups, Decisions, Memory, Activity), beside a sticky rail of the at-a-glance facts. Each
// fact and each act appears once: the facts live in the rail, Accept / Reject only beside the diff.
// Everything derived (whose turn, coverage, history) comes from core's read model.

import { Written } from "@/lib/i18n/written";
import {
  ActorChip,
  AGENT_TINT,
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
import { ItemMemory, useItemMemoryCount } from "@/features/memory/components/item-memory";
import { MockupsPanel } from "@/features/mockups/components/mockups-panel";
import { useMockups } from "@/features/mockups/hooks";
import { PendingBadge, RequirementSuggestions } from "@/features/suggestions/components/suggestion-list";
import { useWaitingSuggestions } from "@/features/suggestions/hooks";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useRequirement, useRequirementDecisions } from "../hooks";
import type { RequirementDetail, RequirementRevision } from "../types";
import { ProposalDecision, ProposeChange } from "./requirement-actions";
import { RequirementFacts, RequirementPhoneProgressOf } from "./requirement-facts";
import { CriteriaTable, History, Readiness, RevisionDiff, RevisionList } from "./requirement-proof";
import { RequirementDecisions } from "./requirement-decisions";
import { AssumptionsSection, UnclearSection } from "./requirement-unclear";
import { RequirementBanner } from "./standing-bits";

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
  const f = d.standing.facts;
  return (
    <section data-testid="view-criteria">
      <ViewHeading>{t("requirements.criteria.heading")}</ViewHeading>
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-muted">
        <span>
          {t("requirements.criteria.passing")} <b className="font-semibold text-fg">{t("requirements.criteria.nOfM", { a: f.passing, b: f.criteria })}</b>
        </span>
        <Readiness suggestions={sug.data?.suggestions ?? []} />
        {d.standing.shownRevision !== null ? (
          <>
            <span aria-hidden>·</span>
            <span>{t("requirements.criteria.wordingOf", { r: d.standing.shownRevision })}</span>
          </>
        ) : null}
      </div>
      <CriteriaTable d={d} slug={slug} />
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
      <div className="mt-3">
        <FieldLabel>{t("requirements.revision.changesAgainst", { r: base?.revision ?? "—" })}</FieldLabel>
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
  const t = useCopy();
  const open = d.revisions.find((r) => r.state === "proposed" || r.state === "draft");
  return (
    <div className="grid gap-8" data-testid="view-revisions">
      {open ? <OpenRevision d={d} projectId={projectId} open={open} /> : null}
      <section>
        <ViewHeading right={d.standing.attentionGroup !== "done" ? <ProposeChange projectId={projectId} reqKey={d.key} /> : undefined}>
          {t("requirements.revision.all")}
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
  const t = useCopy();
  const q = useRequirement(projectId, reqKey);
  const decisions = useRequirementDecisions(projectId, reqKey);
  const memories = useItemMemoryCount(projectId, reqKey);
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
        const banner = s.waitingOn.kind === "you" || (s.attentionGroup === "stuck" && s.waitingOn.kind === "none");
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
            {banner ? <RequirementBanner standing={s} className="px-8 py-2.5 max-md:px-4" /> : null}
            <RequirementPhoneProgressOf d={d} slug={slug} projectId={projectId} />
            <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="requirement-tabs" />
            <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("requirements.tab.overview")}>
              {tab === "overview" ? <Overview d={d} projectId={projectId} slug={slug} /> : null}
              {tab === "criteria" ? <Criteria d={d} projectId={projectId} slug={slug} /> : null}
              {tab === "revisions" ? <Revisions d={d} projectId={projectId} /> : null}
              {tab === "mockups" ? <MockupsPanel projectId={projectId} target={mockupTarget} /> : null}
              {tab === "decisions" ? (
                <section data-testid="view-decisions" aria-label={t("requirements.tab.decisions")}>
                  <RequirementDecisions projectId={projectId} slug={slug} reqKey={d.key} />
                </section>
              ) : null}
              {tab === "memory" ? <ItemMemory projectId={projectId} slug={slug} cites={d.key} /> : null}
              {tab === "activity" ? (
                <section data-testid="view-activity" aria-label={t("requirements.tab.activity")}>
                  <History entries={d.history} />
                </section>
              ) : null}
            </DetailPane>
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}
