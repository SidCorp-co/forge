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
  Icon,
  IconButton,
  Markdown,
  Menu,
  MonoTag,
  PipelineTracker,
  ProjectLoader,
  Skeleton,
  StatusChip,
  Tabs,
  type TabItem,
} from "@/design";
import { coreFileUrl } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useToast } from "@/providers/toast-provider";
import { useRecents, buildShareLink } from "@/features/shell";
import { useProjects } from "@/features/projects/hooks";
import { parseChecklist, statusLabel, statusToChip, statusToRun, statusToStage } from "../derive";
import {
  usePatchIssue,
  useIssueCost,
  useIssueDeps,
  useProjectMembers,
  useTransitionIssue,
} from "../hooks";
import { useActivity, useAttachments, useComments, useIssue, useTasks } from "../detail-hooks";
import type { AttachmentRow, IssueStatus, TaskRow } from "../types";
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

// Human labels for the task lifecycle — the Tasks tab badge must read "In
// progress", not the raw wire value `in_progress` (ISS-349, matching the issue
// label helpers in derive.ts).
const TASK_STATUS_LABELS: Record<TaskRow["status"], string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
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
  const attachmentsQ = useAttachments(id);
  const depsQ = useIssueDeps(id);
  const costQ = useIssueCost(id);
  const membersQ = useProjectMembers(projectId);
  // Breadcrumb shows the friendly project name, not the raw slug. Reuses the
  // already-cached `['projects']` list (loaded by the shell) — no extra fetch;
  // falls back to the slug while the list is still loading (ISS-347 follow-up).
  const projectsQ = useProjects();
  const projectName =
    projectsQ.data?.find((p) => p.id === projectId)?.name ?? slug;

  const patch = usePatchIssue();
  const transition = useTransitionIssue();
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
    <div className="mx-auto min-h-dvh w-full max-w-[1600px] px-4 py-6 sm:px-8 sm:py-8 2xl:max-w-[1760px]">
      <Breadcrumb
        items={[
          { label: projectName, href: `/projects/${slug}` },
          { label: "Issues", href: `/projects/${slug}/issues` },
          { label: issue.displayId },
        ]}
        onNavigate={(href) => router.push(href)}
      />

      {/* Sticky action + state bar — keeps the id, live status, and the primary
          actions reachable while scrolling a long issue (ISS-347). Full-bleed
          via negative gutters so the backdrop spans the content width. */}
      <div className="sticky top-0 z-20 -mx-4 mb-5 mt-3 flex items-start gap-3 border-b border-line-subtle bg-app/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
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
            <span className="fg-caption">{statusLabel(issue.status)}</span>
          </div>
          <h1 className="fg-h3 mt-1.5 truncate">{issue.title}</h1>
        </div>
        <div className="hidden flex-none items-center gap-2 sm:flex">
          <HelpButton
            summary="The full record for one issue: pipeline progress, description, acceptance criteria, the agent plan, and Comments / Activity / Tasks."
            actions={[
              "Edit properties (status, priority, assignee) in the rail",
              "Jump to related sessions, pipeline, and runs",
            ]}
            shortcuts={[{ keys: "⌘K", desc: "Open the command palette" }]}
          />
          <Button
            variant="secondary"
            size="sm"
            icon="agent"
            onClick={() => router.push(`/projects/${slug}/agents?issue=${id}`)}
          >
            Open sessions
          </Button>
          <Menu
            align="right"
            items={[
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

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* Main column */}
        <div className="min-w-0 space-y-4">
          <Card>
            <CardContent>
              <PipelineTracker
                stage={stage}
                status={statusToRun(issue.status, issue.agentStatus)}
                variant="full"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Description</CardTitle>
            </CardHeader>
            <CardContent>
              {issue.description ? (
                // Fill the full column width (ISS-351) — wide tables, code
                // blocks, and long lines use the available space rather than a
                // narrow ~70ch clamp.
                <Markdown>{issue.description}</Markdown>
              ) : (
                <p className="fg-body-sm text-muted">No description.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Attachments</CardTitle>
            </CardHeader>
            <CardContent>
              {attachmentsQ.isLoading ? (
                <Skeleton variant="text" className="w-40" />
              ) : (attachmentsQ.data?.length ?? 0) === 0 ? (
                <p className="fg-body-sm text-muted">No attachments.</p>
              ) : (
                <AttachmentGrid rows={attachmentsQ.data ?? []} />
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
                    <TabLoading />
                  ) : (
                    <CommentThread
                      issueId={id}
                      comments={commentsQ.data ?? []}
                      members={membersQ.data}
                    />
                  ))}
                {tab === "activity" &&
                  (activityQ.isLoading ? (
                    <TabLoading />
                  ) : (
                    <ActivityFeed items={activityQ.data?.items ?? []} />
                  ))}
                {tab === "tasks" &&
                  (tasksQ.isLoading ? (
                    <TabLoading />
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
                          <Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABELS[t.status]}</Badge>
                        </li>
                      ))}
                    </ul>
                  ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Properties rail — desktop sidebar (sticky so it stays in view while
            reading a long comment thread, ISS-347 follow-up); mobile collapsible.
            `self-start` keeps the grid item at content height so sticky has room;
            `top-20` clears the pinned action bar; a max-height + scroll keeps a
            long rail (many deps) usable. */}
        <aside className="hidden lg:sticky lg:top-20 lg:block lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto">
          <Card>
            <CardHeader>
              <CardTitle>Properties</CardTitle>
            </CardHeader>
            <CardContent>
              <PropertiesRail
                issue={issue}
                slug={slug}
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
              slug={slug}
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

/** Skeleton placeholder for the detail tab bodies (comments / activity / tasks)
 *  while their queries load — replaces the bare "Loading …" text (ISS-308 F1). */
function TabLoading() {
  return (
    <div className="space-y-3" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-2.5">
          <Skeleton variant="circle" className="size-[26px] flex-none" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton variant="text" className="w-32" />
            <Skeleton variant="text" className="w-full max-w-[24rem]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Attachment list for the issue detail (ISS-351). Images render as clickable
 *  thumbnails (open full size in a new tab); everything else as a download
 *  link with name + size. */
function AttachmentGrid({ rows }: { rows: AttachmentRow[] }) {
  return (
    <ul className="flex flex-wrap gap-3">
      {rows.map((a) => {
        const href = coreFileUrl(a.url);
        const isImage = a.mime.startsWith("image/");
        return (
          <li key={a.id}>
            {isImage ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                title={`${a.name} · ${formatBytes(a.size)}`}
                className="block overflow-hidden rounded-md border border-line hover:border-line-strong"
              >
                {/* biome-ignore lint/a11y/useAltText: alt is the file name */}
                <img
                  src={href}
                  alt={a.name}
                  className="h-28 w-28 object-cover"
                  loading="lazy"
                />
              </a>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 hover:bg-hover"
              >
                <Icon name="folder" size={16} className="flex-none text-subtle" />
                <span className="fg-body-sm max-w-[14rem] truncate text-fg" title={a.name}>
                  {a.name}
                </span>
                <span className="fg-caption flex-none">{formatBytes(a.size)}</span>
              </a>
            )}
          </li>
        );
      })}
    </ul>
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
