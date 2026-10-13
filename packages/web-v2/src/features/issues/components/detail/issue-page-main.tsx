
import type { IssueBlocker } from "@forge/contracts/issue-standing";
import type { ParkThreadQuestion } from "@forge/contracts/park";
import type { ComponentProps, ReactNode } from "react";
import { type RecordView, RecordViewSwitch } from "@/design";
import { useIssueForecast } from "@/features/forecast";
import { IssuePreview } from "@/features/previews";
import { settingsHref } from "@/features/project-settings";
import { IssueQuestions } from "@/features/questions";
import type { useActivity, useAttachments, useComments } from "../../detail-hooks";
import type { useIssueStandingOf, useProjectMembers } from "../../hooks";
import type { IssueDetail, IssueStatus } from "../../types";
import { AwaitingReleaseBanner } from "../awaiting-release-banner";
import { BlockerBanner } from "../blocker-banner";
import { IssueChanges } from "../issue-changes";
import { IssueCriteria } from "../issue-criteria";
import { type LiveAgentState, LiveAgent } from "../live-agent";
import { IssuePatternList } from "../issue-pattern-list";
import { IssueDetails } from "./issue-details";
import { IssueStateHead } from "./issue-state-head";

/** The main column of the page: the state head, what needs a person, the criteria, the preview, the change and the Details. */
export function IssuePageMain(props: {
  issue: IssueDetail;
  projectId: string;
  slug: string;
  id: string;
  canWrite: boolean;
  pending: boolean;
  /** A person's view, or a developer's with every fold open and the agent text drawn. */
  view: RecordView;
  onView: (view: RecordView) => void;
  standingQ: ReturnType<typeof useIssueStandingOf>;
  blocker: IssueBlocker | null;
  needsYouAct: ReactNode;
  threadQuestion: ParkThreadQuestion | null;
  onAnswerInThread: ((text: string) => Promise<unknown>) | undefined;
  onTransition: (to: IssueStatus) => void;
  onResumeRun: (runId: string) => void;
  onProvideInfo: () => void;
  agentState: LiveAgentState | null;
  liveStep: string | null;
  attachmentsQ: ReturnType<typeof useAttachments>;
  commentsQ: ReturnType<typeof useComments>;
  activityQ: ReturnType<typeof useActivity>;
  membersQ: ReturnType<typeof useProjectMembers>;
  mockupTarget: ComponentProps<typeof IssueDetails>["mockupTarget"];
  mockupCount: number | undefined;
  checklist: { key: string; text: string; checked: boolean }[];
  reasonDialog: ReactNode;
}) {
  const { issue, projectId, slug, id, canWrite, pending, view, standingQ, blocker, agentState, liveStep } = props;
  const forecast = useIssueForecast(issue.projectId, issue.displayId).data?.forecast;
  const developer = view === "developer";
  const standing = standingQ.data?.standing;
  return (
          <div className="max-w-225 px-8 pb-16 pt-5 max-md:px-4" data-testid="issue-page-main">
            <div className="mb-3 flex justify-end" data-testid="issue-view-switch">
              <RecordViewSwitch view={view} onView={props.onView} />
            </div>
            <div data-highlight="waiting question">
              {standing ? <IssueStateHead standing={standing} forecast={forecast} act={props.needsYouAct} /> : null}
            </div>
            <div className="grid gap-3 empty:hidden" data-testid="issue-needs-you-panels">
              <IssueQuestions
                show="now"
                issueId={issue.id}
                parkedForInfo={issue.status === "needs_info"}
                threadQuestion={props.threadQuestion}
                onAnswerInThread={props.onAnswerInThread}
              />
              <IssuePatternList issueId={issue.id} projectId={issue.projectId} show="open" />
              {props.reasonDialog}
            </div>
            {developer && blocker ? (
              <div className="mt-3">
                <BlockerBanner
                  blocker={blocker}
                  slug={slug}
                  pending={pending || !canWrite}
                  onResumePark={props.onTransition}
                  onResumeRun={props.onResumeRun}
                  onProvideInfo={props.onProvideInfo}
                />
              </div>
            ) : null}
            {developer ? <AwaitingReleaseBanner projectId={issue.projectId} issueId={issue.id} canWrite={canWrite} /> : null}
            {developer && agentState ? <LiveAgent state={agentState} step={liveStep ?? "—"} slug={slug} issueId={id} /> : null}
            <div className="border-b border-line-subtle py-4">
              <IssueCriteria
                issue={issue}
                projectId={projectId}
                checklist={props.checklist}
                canWrite={canWrite}
                requirementKey={standingQ.data?.standing.requirement?.key ?? null}
                developer={developer}
              />
            </div>
            <div className="border-b border-line-subtle py-4" data-highlight="preview">
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
