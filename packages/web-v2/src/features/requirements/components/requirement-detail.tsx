
// A requirement's full page: one column for reading and acting, its at-a-glance facts (owner, issues,
// designs, contracts, mockups) a Properties drawer opened on demand, never an inline rail (ISS-903). The
// column opens on one strip (whose turn, where it stands on the lifecycle and
// what is next, k/n verified), then the requirement's picture above any text (REQ-35 BC-1,
// `requirement-picture.tsx`), then its views by tabs: the Overview reads Problem, Value and Measured
// by, then the criteria as short rows, then what is still unclear (REQ-65 BC-7, ISS-691,
// `requirement-overview.tsx`); then Revisions, Mockups, Activity, and Memory in the developer view.
// Revisions holds the open one and the act that proposes the next; the revisions that stood before
// and the decisions taken are past items, read folded under Activity (REQ-35 BC-7, REQ-43 BC-8). Each fact and each act appears once: Accept / Reject only beside the diff; a count is said
// once, so no tab counts what its view counts (BC-5). A person's view leaves the agent text out —
// criterion codes, revision numbers, the assistant's draft, agent memory — and `?view=developer`
// draws it (BC-7). Everything derived (whose turn, coverage, history) comes from core's read model.

import { Written } from "@/lib/i18n/written";
import {
  ActorChip,
  AGENT_TINT,
  DetailDrawer,
  Disclosure,
  DetailMobileTitle,
  DetailPane,
  FactsRail,
  StatusBadge,
  useRecordView,
  useRecordViewCommands,
  useUrlTab,
  ViewHeading,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { RequirementTabs } from "./requirement-tabs";
import { MockupList, RequirementMockups } from "@/features/mockups";
import { useMockups } from "@/features/mockups";
import { PendingBadge } from "@/features/suggestions";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useRequirement } from "../hooks";
import type { RequirementDetail, RequirementRevision } from "../types";
import { ProposalDecision, ProposeChange } from "./requirement-actions";
import { RequirementProperties } from "./requirement-facts";
import { CriteriaChanges, RevisionDiff } from "./requirement-proof";
import { RequirementActivity } from "./requirement-activity";
import { RequirementMemory, useRequirementMemoryCount } from "./requirement-memory";
import { RequirementOverview } from "./requirement-overview";
import { RequirementPicture } from "./requirement-picture";
import { DraftRevisionEditor, NewRevision } from "./revision-editor";
import { RequirementStandingHead } from "./standing-bits";

const REQUIREMENT_TABS = ["overview", "revisions", "mockups", "activity", "memory"] as const;
type RequirementTab = (typeof REQUIREMENT_TABS)[number];

/** The open view rides `?tab=`, written without a navigation, so back from an issue lands on it. */
export const useRequirementTab = () => useUrlTab(REQUIREMENT_TABS);

function OpenRevision({ d, projectId, open }: { d: RequirementDetail; projectId: string; open: RequirementRevision }) {
  const t = useCopy();
  const time = useTimeFormat();
    const proposed = open.state === "proposed";
  // a proposal this reader decides (the Accept and Reject below are theirs) opens on its diff, so
  // nobody accepts a change they have not seen; every other revision stays folded (REQ-35 BC-7)
  const awaitsReader = proposed && d.canSignOff;
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
        <Disclosure key={open.revision} defaultOpen={awaitsReader} title={t("requirements.revision.changesAgainst", { r: open.specChanges.against ?? "—" })}>
          <RevisionDiff changes={open.specChanges} />
        </Disclosure>
      </div>
      {proposed ? (
        <div className="mt-4">
          <ProposalDecision projectId={projectId} d={d} revision={open.revision} />
        </div>
      ) : (
        <div className="mt-4">
          <DraftRevisionEditor projectId={projectId} d={d} draft={open} />
        </div>
      )}
    </section>
  );
}

/**
 * The open revision, written in place while it is a draft; with none open, the act that opens the
 * next on the head, by hand or through the assistant. The revisions that stood before are Activity's.
 */
function Revisions({ d, projectId }: { d: RequirementDetail; projectId: string }) {
  const t = useCopy();
  const open = d.revisions.find((r) => r.state === "proposed" || r.state === "draft");
  const canPropose = d.standing.attentionGroup !== "done";
  return (
    <div className="grid gap-8" data-testid="view-revisions">
      {open ? <OpenRevision d={d} projectId={projectId} open={open} /> : null}
      {canPropose ? (
        <div className="flex flex-wrap items-start justify-end gap-2" data-testid="revision-propose">
          {!open && d.currentRevision !== null ? <NewRevision projectId={projectId} d={d} /> : null}
          <ProposeChange projectId={projectId} reqKey={d.key} />
        </div>
      ) : null}
      {!open && !canPropose ? <p className="text-13 text-subtle">{t("requirements.revision.noneOpen")}</p> : null}
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
  useRecordViewCommands(view, onView);
  const q = useRequirement(projectId, reqKey);
  const memories = useRequirementMemoryCount(projectId, reqKey);
  const mockupTarget = { type: "requirement" as const, key: reqKey };
  const mockups = useMockups(projectId, mockupTarget);
  return (
    <QueryBoundary query={q} loadingLabel={t("requirements.loadingOne")}>
      {(data) => {
        const d = data;
        const s = d.standing;
        const tabs = [
          { value: "overview" as const, label: t("requirements.tab.overview"), count: d.unclear || undefined },
          { value: "revisions" as const, label: t("requirements.tab.revisions") },
          { value: "mockups" as const, label: t("requirements.tab.mockups"), count: mockups.data?.returned },
          { value: "activity" as const, label: t("requirements.tab.activity") },
          ...(developer ? [{ value: "memory" as const, label: t("memory.title"), count: memories }] : []),
        ];
        // memory is the developer view's: a person's view reading ?tab=memory opens on the Overview
        const shownTab = tabs.some((x) => x.value === tab) ? tab : "overview";
        return (
          <article className="min-h-full bg-app" data-testid="requirement-detail" data-key={d.key}>
            {/* the key is the title's tooltip, never text before it (ISS-903) */}
            <DetailMobileTitle title={<span title={d.key}>{d.title}</span>} badge={<StatusBadge family="requirement" value={s.state} />} />
            <RequirementStandingHead projectId={projectId} reqKey={reqKey} standing={s} slug={slug} inset="px-8 max-md:px-4" />
            <RequirementPicture d={d} projectId={projectId} slug={slug} inset="px-8 max-md:px-4" />
            <div className="flex items-end justify-between gap-3 pr-8 pt-3 max-md:flex-col-reverse max-md:items-end max-md:gap-0 max-md:pr-4" data-testid="requirement-tabs-bar">
              <div className="min-w-0 flex-1 max-md:w-full max-md:flex-none">
                <RequirementTabs tabs={tabs} value={shownTab} onTab={onTab} />
              </div>
              <DetailDrawer label={t("common.properties")} testId="requirement-properties">
                <FactsRail testId="relations-rail">
                  <RequirementProperties
                    d={d}
                    slug={slug}
                    onOpenRevisions={() => onTab("revisions")}
                    projectId={projectId}
                    developer={developer}
                    more={<RequirementMockups projectId={projectId} slug={slug} reqKey={d.key} />}
                  />
                </FactsRail>
              </DetailDrawer>
            </div>
            <DetailPane label={tabs.find((x) => x.value === shownTab)?.label ?? t("requirements.tab.overview")}>
              {shownTab === "overview" ? <RequirementOverview d={d} projectId={projectId} slug={slug} onRevise={() => onTab("revisions")} developer={developer} /> : null}
              {shownTab === "revisions" ? <Revisions d={d} projectId={projectId} /> : null}
              {shownTab === "mockups" ? <MockupList projectId={projectId} slug={slug} target={mockupTarget} hostViewer={false} /> : null}
              {shownTab === "memory" ? <RequirementMemory projectId={projectId} slug={slug} reqKey={d.key} /> : null}
              {shownTab === "activity" ? <RequirementActivity projectId={projectId} slug={slug} d={d} /> : null}
            </DetailPane>
          </article>
        );
      }}
    </QueryBoundary>
  );
}
