import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { getProject, getIssues, getTasks } from "@/lib/api";
import { StatCard } from "@/components/ui/stat-card";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export function ProjectOverview() {
  const { slug } = useParams<{ slug: string }>();

  const { data: project, isLoading: loadingProject } = useQuery({
    queryKey: ["project", slug],
    queryFn: () => getProject(slug!),
    enabled: !!slug,
  });

  const { data: issues, isLoading: loadingIssues } = useQuery({
    queryKey: ["issues", slug],
    queryFn: () => getIssues(slug!),
    enabled: !!slug,
  });

  const { data: tasks, isLoading: loadingTasks } = useQuery({
    queryKey: ["tasks", slug],
    queryFn: () => getTasks(slug!),
    enabled: !!slug,
  });

  const isLoading = loadingProject || loadingIssues || loadingTasks;

  const allIssues = issues ?? [];
  const allTasks = tasks ?? [];

  const open = allIssues.filter((i) => ["open", "reopen"].includes(i.status)).length;
  const inProgress = allIssues.filter((i) => ["confirmed", "approved", "in_progress"].includes(i.status)).length;
  const resolved = allIssues.filter((i) => ["released", "closed"].includes(i.status)).length;

  const totalTasks = allTasks.length;
  const doneTasks = allTasks.filter((t) => t.status === "done").length;
  const activeTasks = allTasks.filter((t) => t.status === "in_progress" || t.status === "in_review").length;
  const runningAgents = allTasks.filter((t) => t.agentStatus === "running").length;
  const completionRate = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  const recentIssues = [...allIssues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 6);

  const recentTasks = [...allTasks]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 6);

  if (isLoading) {
    return (
      <div className="p-6">
        <SectionLabel>Issues</SectionLabel>
        <div className="mb-6 grid grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
        </div>
        <SectionLabel>Tasks</SectionLabel>
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
        </div>
        <div className="mb-6 flex gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-28 rounded-lg" />)}
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <Skeleton className="mb-2 h-5 w-28" />
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
          </div>
          <div className="space-y-2">
            <Skeleton className="mb-2 h-5 w-28" />
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Issue Stats */}
      <SectionLabel>Issues</SectionLabel>
      <div className="mb-6 grid grid-cols-3 gap-3 animate-fade-in-up">
        <StatCard label="Open" value={open} accent="text-blue-600" />
        <StatCard label="In Progress" value={inProgress} accent="text-purple-600" />
        <StatCard label="Resolved" value={resolved} accent="text-green-600" />
      </div>

      {/* Task Stats */}
      <SectionLabel>Tasks</SectionLabel>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 animate-fade-in-up" style={{ animationDelay: "50ms" }}>
        <StatCard label="Total Tasks" value={totalTasks} />
        <StatCard label="Active" value={activeTasks} />
        <StatCard label="Completion" value={`${completionRate}%`} />
        <StatCard label="Running Agents" value={runningAgents} accent={runningAgents > 0 ? "text-blue-600" : undefined} />
      </div>

      {/* Quick Actions */}
      <div className="mb-6 flex gap-3 animate-fade-in-up" style={{ animationDelay: "100ms" }}>
        <Link
          to={`/project/${slug}/issues`}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700"
        >
          View Issues
        </Link>
        <Link
          to={`/project/${slug}/issues/new`}
          className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          New Issue
        </Link>
        <Link
          to={`/project/${slug}/board`}
          className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Task Board
        </Link>
        <Link
          to={`/project/${slug}/agent`}
          className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Agent Chat
        </Link>
      </div>

      {/* Recent Activity Grid */}
      <div className="grid gap-6 md:grid-cols-2 animate-fade-in-up" style={{ animationDelay: "150ms" }}>
        {/* Recent Issues */}
        <section>
          <SectionLabel>Recent Issues</SectionLabel>
          {recentIssues.length === 0 ? (
            <EmptyState title="No issues yet." />
          ) : (
            <ul className="space-y-2">
              {recentIssues.map((issue) => (
                <li key={issue.id}>
                  <Link
                    to={`/project/${slug}/issues`}
                    className="block rounded-lg border border-gray-200 bg-white p-3 transition hover:shadow-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-gray-900">
                        <span className="mr-1.5 font-mono text-xs text-gray-400">ISS-{issue.id}</span>
                        {issue.title}
                      </span>
                      <StatusBadge status={issue.status} />
                    </div>
                    <p className="mt-1 text-xs text-gray-400">
                      {issue.priority !== "none" && `${issue.priority} · `}
                      {new Date(issue.updatedAt).toLocaleDateString()}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent Tasks */}
        <section>
          <SectionLabel>Recent Tasks</SectionLabel>
          {recentTasks.length === 0 ? (
            <EmptyState title="No tasks yet." />
          ) : (
            <ul className="space-y-2">
              {recentTasks.map((task) => (
                <li key={task.id}>
                  <Link
                    to={`/project/${slug}/board`}
                    className="block rounded-lg border border-gray-200 bg-white p-3 transition hover:shadow-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-gray-900">{task.title}</span>
                      <span className="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
                        {task.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-400">
                      {task.assignee && `${task.assignee} · `}
                      {task.agentStatus === "running" ? (
                        <span className="text-blue-600">Agent running</span>
                      ) : (
                        new Date(task.updatedAt).toLocaleDateString()
                      )}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
