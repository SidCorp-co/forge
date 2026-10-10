"use client";

// The Details of an issue page: folded rows, one per kind of long record. A row shows its label and
// one short summary; the body opens under it. The developer view opens every row and adds the ones
// only a developer reads (the plan, runs, mockups, memory: agent text, REQ-43 BC-7), so a person's
// page is the same page folded. Past items — decided patterns, past decisions, retired criteria —
// sit in Activity (BC-8).

import { type ReactNode, useState } from "react";
import { Disclosure, Markdown, ViewHeading } from "@/design";
import { AttachmentList } from "@/features/attachments";
import { IssueQuestions } from "@/features/questions";
import { MockupList } from "@/features/mockups";
import type { MockupTarget } from "@/features/mockups";
import { useCopy } from "@/lib/i18n/interface-language";
import type { useActivity, useAttachments, useComments } from "../../detail-hooks";
import type { useIssueStandingOf, useProjectMembers } from "../../hooks";
import type { IssueDetail } from "../../types";
import { IssueRetiredCriteria } from "../criteria-list";
import { IssueDescription } from "../issue-description";
import { IssuePatternList } from "../issue-pattern-list";
import { IssueDecisionsTab, IssueMemoryTab } from "./issue-record-tabs";
import { ActivityTab, type ActivityThread, RunsTab, runsTabCount } from "./issue-sections";

/** How many numbered steps a plan lists at its left edge; 0 for a plan written as prose. */
export function planSteps(plan: string): number {
  return plan.split("\n").filter((line) => /^\d+[.)]\s/.test(line)).length;
}

export function IssueDetails({
  issue,
  projectId,
  slug,
  canWrite,
  developer,
  attachmentsQ,
  commentsQ,
  activityQ,
  membersQ,
  standingQ,
  mockupTarget,
  mockupCount,
}: {
  issue: IssueDetail;
  projectId: string;
  slug: string;
  canWrite: boolean;
  developer: boolean;
  attachmentsQ: ReturnType<typeof useAttachments>;
  commentsQ: ReturnType<typeof useComments>;
  activityQ: ReturnType<typeof useActivity>;
  membersQ: ReturnType<typeof useProjectMembers>;
  standingQ: ReturnType<typeof useIssueStandingOf>;
  mockupTarget: MockupTarget;
  mockupCount: number | undefined;
}) {
  const t = useCopy();
  const [explicit, setExplicit] = useState<Record<string, boolean>>({});
  const [thread, setThread] = useState<ActivityThread>("comments");
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const isOpen = (key: string) => explicit[key] ?? developer;
  const toggle = (key: string) => setExplicit((cur) => ({ ...cur, [key]: !isOpen(key) }));
  const files = attachmentsQ.data ?? [];
  const steps = issue.plan ? planSteps(issue.plan) : 0;
  const sessions = issue.agentSessions ?? [];
  const stepOutcomes = standingQ.data?.stepOutcomes ?? [];
  const row = (key: string, label: string, summary: ReactNode, body: ReactNode, highlight?: string) => (
    <Disclosure key={key} title={label} summary={summary} open={isOpen(key)} onOpenChange={() => toggle(key)} testId={`details-${key}`} highlight={highlight}>
      {body}
    </Disclosure>
  );
  return (
    <section aria-label={t("issues.details.title")} data-testid="issue-details">
      <ViewHeading>{t("issues.details.title")}</ViewHeading>
      <div>
        {developer
          ? row(
              "plan",
              t("issues.plan.title"),
              issue.plan ? (steps > 0 ? t("issues.plan.steps", { n: steps }) : t("issues.plan.written")) : t("issues.now.none"),
              issue.plan ? <Markdown>{issue.plan}</Markdown> : <p className="text-13 text-subtle">{t("issues.now.none")}</p>,
              "plan",
            )
          : null}
        {row("description", t("issues.description.title"), null, <IssueDescription issue={issue} attachments={files} canWrite={canWrite} />)}
        {row(
          "files",
          t("issues.files.title"),
          attachmentsQ.isError ? t("common.couldNotLoad") : files.length || t("issues.now.none"),
          files.length > 0 ? <AttachmentList rows={files} /> : <p className="text-13 text-subtle">{t("issues.now.none")}</p>,
        )}
        {row(
          "activity",
          t("issues.tab.activity"),
          commentsQ.data?.totalCount ?? null,
          <ActivityTab
            issueId={issue.id}
            thread={thread}
            onThread={setThread}
            commentsQ={commentsQ}
            activityQ={activityQ}
            members={membersQ.data}
            canWrite={canWrite}
            past={
              <>
                <IssuePatternList issueId={issue.id} projectId={projectId} show="decided" />
                <IssueQuestions issueId={issue.id} show="past" />
                <IssueDecisionsTab projectId={projectId} issueKey={issue.displayId} />
                <IssueRetiredCriteria issueId={issue.id} />
              </>
            }
          />,
        )}
        {developer
          ? row(
              "runs",
              t("issues.tab.runs"),
              runsTabCount(sessions, stepOutcomes),
              <RunsTab
                issueId={issue.id}
                slug={slug}
                sessions={sessions}
                standingQ={standingQ}
                stepOutcomes={stepOutcomes}
                expandedStep={expandedStep}
                onToggleStep={(step) => setExpandedStep((cur) => (cur === step ? null : step))}
              />,
            )
          : null}
        {developer ? row("mockups", t("common.mockups.title"), mockupCount ?? null, <MockupList projectId={projectId} target={mockupTarget} />) : null}
        {developer ? row("memory", t("memory.title"), null, <IssueMemoryTab projectId={projectId} slug={slug} issueKey={issue.displayId} />) : null}
      </div>
    </section>
  );
}
