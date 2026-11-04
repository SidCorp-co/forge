
import type { IssueBlocker } from "@forge/contracts/issue-standing";
import type { ParkThreadQuestion } from "@forge/contracts/park";
import type { ComponentProps } from "react";
import { DetailLeadEnd, type RecordView, RecordViewSwitch } from "@/design";
import { useIssueForecast } from "@/features/forecast";
import { IssuePreview } from "@/features/previews";
import { StewardNoteLines, useStewardNote } from "@/features/standing";
import { settingsHref } from "@/features/project-settings";
import { IssueQuestions } from "@/features/questions";
import type { useActivity, useAttachments, useComments } from "../../detail-hooks";
import type { useIssueStandingOf, useProjectMembers } from "../../hooks";
import type { IssueDetail } from "../../types";
import { AwaitingReleaseBanner } from "../awaiting-release-banner";
import { BlockerBanner } from "../blocker-banner";
import { IssueChanges } from "../issue-changes";
import { IssueCriteria } from "../issue-criteria";
import { type LiveAgentState, LiveAgent } from "../live-agent";
import { IssuePatternList } from "../issue-pattern-list";
import { IssueDetails } from "./issue-details";
import { IssueStuckBanner } from "../issue-standing-bits";
import { IssueStateHead } from "./issue-state-head";

/** The main column of the page: the state head, the criteria, the preview, the change and the Details. */
export function IssuePageMain(props: {
  issue: IssueDetail;
  projectId: string;
  slug: string;
  id: string;
  canWrite: boolean;
  /** A person's view, or a developer's with every fold open and the agent text drawn. */
  view: RecordView;
  onView: (view: RecordView) => void;
  standingQ: ReturnType<typeof useIssueStandingOf>;
  blocker: IssueBlocker | null;
  threadQuestion: ParkThreadQuestion | null;
  onAnswerInThread: ((text: string) => Promise<unknown>) | undefined;
  agentState: LiveAgentState | null;
  liveStep: string | null;
  attachmentsQ: ReturnType<typeof useAttachments>;
  commentsQ: ReturnType<typeof useComments>;
  activityQ: ReturnType<typeof useActivity>;
  membersQ: ReturnType<typeof useProjectMembers>;
  mockupTarget: ComponentProps<typeof IssueDetails>["mockupTarget"];
  mockupCount: number | undefined;
  checklist: { key: string; text: string; checked: boolean }[];
}) {
  const { issue, projectId, slug, id, canWrite, view, standingQ, blocker, agentState, liveStep } = props;
  const forecast = useIssueForecast(issue.projectId, issue.displayId).data?.forecast;
  const developer = view === "developer";
  const standing = standingQ.data?.standing;
  const note = useStewardNote(projectId, "issue", issue.displayId);
  // a question the issue waits on is answered in Needs you, on the item it serves (REQ-68 BC-4, BC-9);
  // only the developer's view draws it here, as the record it is
  const panels = (
    <div className="grid gap-3 empty:hidden" data-testid="issue-panels">
      {developer ? (
        <IssueQuestions
          show="now"
          issueId={issue.id}
          slug={slug}
          parkedForInfo={issue.status === "needs_info"}
          waitingKind={issue.status === "needs_info" ? (issue.waitingKind ?? null) : null}
          threadQuestion={props.threadQuestion}
          onAnswerInThread={props.onAnswerInThread}
        />
      ) : null}
      <IssuePatternList issueId={issue.id} projectId={issue.projectId} show="open" />
    </div>
  );
  return (
          <div className="px-8 pb-16 pt-5 max-md:px-4" data-testid="issue-page-main">
            <div className="mb-3 flex justify-end" data-testid="issue-view-switch">
              <RecordViewSwitch view={view} onView={props.onView} />
            </div>
            <div data-highlight="waiting question">
              {standing ? <IssueStateHead standing={standing} forecast={forecast} panels={panels} /> : panels}
            </div>
            {/* a stuck issue says why, then the steward's note on it (REQ-48 BC-5, BC-7) */}
            {standing ? <IssueStuckBanner standing={standing} developer={developer} className="mt-3 rounded-md" /> : null}
            <StewardNoteLines note={note} slug={slug} />
            {developer && blocker ? (
              <div className="mt-3">
                <BlockerBanner blocker={blocker} slug={slug} />
              </div>
            ) : null}
            {developer ? <AwaitingReleaseBanner projectId={issue.projectId} issueId={issue.id} /> : null}
            {developer && agentState ? <LiveAgent state={agentState} step={liveStep ?? "—"} slug={slug} issueId={id} /> : null}
            {/* where the issue stands and what it needs is this page's lead: below 1024px the rail follows it */}
            <DetailLeadEnd inset />
            <div className="border-b border-line-divider py-4">
              <IssueCriteria
                issue={issue}
                projectId={standingQ.data?.standing.requirement?.project?.id ?? projectId}
                checklist={props.checklist}
                canWrite={canWrite}
                requirementKey={standingQ.data?.standing.requirement?.key ?? null}
                developer={developer}
              />
            </div>
            <div className="border-b border-line-divider py-4" data-highlight="preview">
              <IssuePreview
                issueId={issue.id}
                issueLabel={issue.displayId}
                canWrite={canWrite}
                settingsHref={settingsHref(slug, "preview")}
                hasLiveRun={(issue.agentSessions ?? []).some((s) => s.status === "running")}
                row={!developer}
              />
            </div>
            <IssueChanges issue={issue} slug={slug} developer={developer} />
            <div className="pt-4">
              <IssueDetails
                key={view}
                issue={issue}
                projectId={projectId}
                slug={slug}
                canWrite={canWrite}
                developer={developer}
                attachmentsQ={props.attachmentsQ}
                commentsQ={props.commentsQ}
                activityQ={props.activityQ}
                membersQ={props.membersQ}
                standingQ={standingQ}
                mockupTarget={props.mockupTarget}
                mockupCount={props.mockupCount}
              />
            </div>
          </div>
  );
}
