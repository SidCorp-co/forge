"use client";

// web-v2 Issue detail (`/v2/projects/[slug]/issues/[id]`). Simple + rich in one
// derived layout: markdown description, AC checklist, collapsible agent plan,
// full PipelineTracker, Comments/Activity/Tasks tabs, and a properties rail.
// Live via WS (`['issue',id]` / `['comments',id]` / `['activities',id]`). ISS-294.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Collapsible,
  EmptyState,
  ErrorState,
  HelpButton,
  IconButton,
  Markdown,
  Menu,
  MonoTag,
  PipelineTracker,
  ProjectLoader,
  StatusChip,
  Tabs,
  type TabItem,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useToast } from "@/providers/toast-provider";
import { useRecents, buildShareLink } from "@/features/shell";
import { parseChecklist, statusToChip, statusToStage } from "../derive";
import {
  usePatchIssue,
  useIssueCost,
  useIssueDeps,
  useProjectMembers,
  useRunPipelineStep,
  useTransitionIssue,
} from "../hooks";
import { useActivity, useComments, useIssue, useTasks } from "../detail-hooks";
import type { IssueStatus, TaskRow } from "../types";
import { ActivityFeed } from "./activity-feed";
import { CommentThread } from "./comment-thread";
import { PropertiesRail } from "./properties-rail";

const TASK_STATUS_TONE: Record<TaskRow["status"], "neutral" | "cobalt" | "amber" | "green"> = {
  backlog: "neutral",
  todo: "neutral",
  in_progress: "cobalt",
  in_review: "amber",
  done: "green",
};

interface IssueDetailScreenProps {
  projectId: string;
  slug: string;
  id: string;
}

export function IssueDetailScreen({ projectId, slug, id }: IssueDetailScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { push: pushRecent } = useRecents();
  const [tab, setTab] = useState("comments");

  useRoom(projectRoom(projectId));

  const issueQ = useIssue(id);
  const commentsQ = useComments(id);
  const activityQ = useActivity(id);
  const tasksQ = useTasks(id);
  const depsQ = useIssueDeps(id);
  const costQ = useIssueCost(id);
  const membersQ = useProjectMembers(projectId);

  const patch = usePatchIssue();
  const transition = useTransitionIssue();
  const runStep = useRunPipelineStep();
  const pending = patch.isPending || transition.isPending;

  const issue = issueQ.data;
  const checklist = useMemo(() => {
    if (issue?.aiAcceptanceCriteria && issue.aiAcceptanceCriteria.length > 0) {
      return issue.aiAcceptanceCriteria.map((text) => ({ text, checked: false }));
    }
    return parseChecklist(issue?.acceptanceCriteria);
  }, [issue?.aiAcceptanceCriteria, issue?.acceptanceCriteria]);

  // Track this issue as recently-viewed (surfaces in the ⌘K Recent group).
  useEffect(() => {
    if (!issue) return;
    pushRecent({
      kind: "issue",
      id,
      label: `${issue.displayId} · ${issue.title}`,
      href: `/projects/${slug}/issues/${id}`,
      icon: "list",
    });
  }, [issue?.displayId, issue?.title, id, slug, pushRecent]);

  function copyLink() {
    const url = buildShareLink(`/projects/${slug}/issues/${id}`);
    navigator.clipboard?.writeText(url).then(
      () => toast({ title: "Link copied", description: url, tone: "success" }),
      () => toast({ title: "Couldn't copy link", tone: "error" }),
    );
  }

  if (issueQ.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading issue…" />
      </div>
    );
  }
  if (issueQ.isError || !issue) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState
          title="Couldn't load issue"
          message={formatApiError(issueQ.error)}
          onRetry={() => issueQ.refetch()}
        />
      </div>
    );
  }

  const stage = statusToStage(issue.status);
  const onTransition = (toStatus: IssueStatus) => transition.mutate({ id, toStatus });
  const onPatch = (body: Parameters<typeof patch.mutate>[0]["body"]) => patch.mutate({ id, body });

  const tabs: TabItem[] = [
    { value: "comments", label: "Comments", count: countComments(commentsQ.data) },
    { value: "activity", label: "Activity", count: activityQ.data?.items.length },
    { value: "tasks", label: "Tasks", count: tasksQ.data?.length },
  ];

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <Breadcrumb
        items={[
          { label: slug, href: `/projects/${slug}` },
          { label: "Issues", href: `/projects/${slug}/issues` },
          { label: issue.displayId },
        ]}
        onNavigate={(href) => router.push(href)}
      />

      {/* Header */}
      <div className="mb-5 mt-3 flex items-start gap-3">
        <IconButton
          icon="arrowRight"
          aria-label="Back to issues"
          className="rotate-180"
          onClick={() => router.push(`/projects/${slug}/issues`)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <MonoTag hue="cobalt">{issue.displayId}</MonoTag>
            <StatusChip status={statusToChip(issue.status, issue.agentStatus)} />
            <span className="fg-caption font-mono">{issue.status}</span>
          </div>
          <h1 className="fg-h2 mt-2 break-words">{issue.title}</h1>
        </div>
        <div className="hidden flex-none items-center gap-2 sm:flex">
          <HelpButton
            summary="The full record for one issue: pipeline progress, description, acceptance criteria, the agent plan, and Comments / Activity / Tasks."
            actions={[
              "Run the next pipeline step",
              "Edit properties (status, priority, assignee) in the rail",
              "Jump to related sessions, pipeline, and runs",
            ]}
            shortcuts={[{ keys: "⌘K", desc: "Open the command palette" }]}
          />
          <Button
            variant="secondary"
            size="sm"
            icon="rerun"
            loading={runStep.isPending}
            onClick={() => runStep.mutate({ id })}
          >
            Run step
          </Button>
          <Menu
            align="right"
            items={[
              { label: "Reopen", icon: "rerun", onSelect: () => onTransition("reopen") },
              {
                label: "Open sessions",
                icon: "agent",
                onSelect: () => router.push(`/projects/${slug}/sessions`),
              },
              {
                label: "Open pipeline",
                icon: "pipeline",
                onSelect: () => router.push(`/projects/${slug}/pipeline`),
              },
              { label: "Copy link", icon: "link", onSelect: copyLink },
            ]}
            trigger={<IconButton icon="more" aria-label="Issue actions" />}
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Main column */}
        <div className="min-w-0 space-y-4">
          <Card>
            <CardContent>
              <PipelineTracker stage={stage} status="running" variant="full" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Description</CardTitle>
            </CardHeader>
            <CardContent>
              {issue.description ? (
                // Clamp prose to a comfortable reading measure (~70ch); data
                // tables elsewhere stay full-width.
                <div className="max-w-[70ch]">
                  <Markdown>{issue.description}</Markdown>
                </div>
              ) : (
                <p className="fg-body-sm text-muted">No description.</p>
              )}
            </CardContent>
          </Card>

          {checklist.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Acceptance criteria</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {checklist.map((item, i) => (
                    <li key={i}>
                      <Checkbox checked={item.checked} disabled label={item.text} />
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {issue.plan && (
            <Collapsible title="Agent plan">
              <Markdown>{issue.plan}</Markdown>
            </Collapsible>
          )}

          <Card>
            <CardContent>
              <Tabs tabs={tabs} value={tab} onChange={setTab} />
              <div className="mt-4">
                {tab === "comments" &&
                  (commentsQ.isLoading ? (
                    <p className="fg-body-sm text-muted">Loading comments…</p>
                  ) : (
                    <CommentThread
                      issueId={id}
                      comments={commentsQ.data ?? []}
                      members={membersQ.data}
                    />
                  ))}
                {tab === "activity" &&
                  (activityQ.isLoading ? (
                    <p className="fg-body-sm text-muted">Loading activity…</p>
                  ) : (
                    <ActivityFeed items={activityQ.data?.items ?? []} />
                  ))}
                {tab === "tasks" &&
                  (tasksQ.isLoading ? (
                    <p className="fg-body-sm text-muted">Loading tasks…</p>
                  ) : (tasksQ.data?.length ?? 0) === 0 ? (
                    <EmptyState title="No tasks" message="This issue has no sub-tasks." mascot={false} />
                  ) : (
                    <ul className="space-y-2">
                      {tasksQ.data?.map((t) => (
                        <li
                          key={t.id}
                          className="flex items-center justify-between gap-3 rounded-md border border-line-subtle px-3 py-2"
                        >
                          <span className="fg-body-sm min-w-0 truncate text-fg">{t.title}</span>
                          <Badge tone={TASK_STATUS_TONE[t.status]}>{t.status}</Badge>
                        </li>
                      ))}
                    </ul>
                  ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Properties rail — desktop sidebar; mobile collapsible. */}
        <aside className="hidden lg:block">
          <Card>
            <CardHeader>
              <CardTitle>Properties</CardTitle>
            </CardHeader>
            <CardContent>
              <PropertiesRail
                issue={issue}
                members={membersQ.data}
                cost={costQ.data}
                deps={depsQ.data}
                pending={pending}
                onPatch={onPatch}
                onTransition={onTransition}
              />
            </CardContent>
          </Card>
        </aside>
        <div className="lg:hidden">
          <Collapsible title="Properties" defaultOpen>
            <PropertiesRail
              issue={issue}
              members={membersQ.data}
              cost={costQ.data}
              deps={depsQ.data}
              pending={pending}
              onPatch={onPatch}
              onTransition={onTransition}
            />
          </Collapsible>
        </div>
      </div>
    </div>
  );
}

function countComments(nodes: { replies: unknown[] }[] | undefined): number | undefined {
  if (!nodes) return undefined;
  let n = 0;
  const walk = (list: { replies: unknown[] }[]) => {
    for (const c of list) {
      n += 1;
      walk((c.replies as { replies: unknown[] }[]) ?? []);
    }
  };
  walk(nodes);
  return n;
}
