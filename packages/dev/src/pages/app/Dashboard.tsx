import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useState, useMemo } from "react";
import { getProjects, getAllIssues } from "@/lib/api";
import { UsageDashboard } from "@/components/usage-dashboard";
import { StatCard } from "@/components/ui/stat-card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { IssueListItem } from "@/components/ui/issue-list-item";
import { PageShell } from "@/components/ui/page-shell";

export function Dashboard() {
  const { data: projects, isLoading: loadingProjects } = useQuery({
    queryKey: ["projects"],
    queryFn: getProjects,
  });
  const { data: issues, isLoading: loadingIssues } = useQuery({
    queryKey: ["all-issues"],
    queryFn: getAllIssues,
  });

  const [search, setSearch] = useState("");

  const allIssues = issues ?? [];
  const totalIssues = allIssues.length;
  const openIssues = allIssues.filter((i) => ["open", "reopen", "approved", "needs_info"].includes(i.status)).length;
  const inProgressIssues = allIssues.filter((i) => i.status === "in_progress").length;
  const resolvedIssues = allIssues.filter((i) => i.status === "released").length;
  const doneIssues = allIssues.filter((i) => i.status === "closed").length;
  const criticalIssues = allIssues.filter((i) => i.priority === "critical" && !["confirmed", "closed"].includes(i.status)).length;
  const highIssues = allIssues.filter((i) => i.priority === "high" && !["confirmed", "closed"].includes(i.status)).length;

  const filteredIssues = useMemo(() => {
    if (!search.trim()) return allIssues.slice(0, 10);
    const q = search.toLowerCase();
    return allIssues.filter(
      (i) => i.title.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q),
    );
  }, [allIssues, search]);

  const recentActivity = useMemo(() => {
    return [...allIssues]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 8);
  }, [allIssues]);

  return (
    <PageShell title="Dashboard" scrollable maxWidth="max-w-5xl">

        {/* Stats Overview */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 animate-fade-in-up">
          <StatCard label="Open" value={openIssues} sub={`${totalIssues} total`} />
          <StatCard label="In Progress" value={inProgressIssues} accent={inProgressIssues > 0 ? "text-blue-600" : undefined} />
          <StatCard label="Released" value={resolvedIssues} sub="Passed all gates" />
          <StatCard label="Closed" value={doneIssues} accent={doneIssues > 0 ? "text-green-600" : undefined} sub="Completed" />
          <StatCard label="Needs Attention" value={criticalIssues + highIssues} accent={criticalIssues + highIssues > 0 ? "text-red-600" : undefined} sub={criticalIssues > 0 ? `${criticalIssues} critical · ${highIssues} high` : `${highIssues} high priority`} />
        </div>

        {/* Search */}
        <div className="mb-6">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search issues by title or description..."
            aria-label="Search issues"
            className="w-full rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm focus:border-gray-400 focus:outline-none"
          />
        </div>

        <div className="mb-8 grid gap-6 md:grid-cols-2 animate-fade-in-up" style={{ animationDelay: "100ms" }}>
          {/* Projects */}
          <section>
            <h2 className="mb-3 text-lg font-semibold text-gray-900">Projects</h2>
            {loadingProjects ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}
              </div>
            ) : !projects || projects.length === 0 ? (
              <EmptyState title="No projects yet." description="Projects will appear here once created in Strapi." />
            ) : (
              <ul className="space-y-2">
                {projects.map((p) => {
                  const projIssues = allIssues.filter((i) => i.project?.slug === p.slug);
                  const projOpen = projIssues.filter((i) => ["open", "reopen", "approved", "needs_info"].includes(i.status)).length;
                  const projActive = projIssues.filter((i) => i.status === "in_progress").length;
                  const projResolved = projIssues.filter((i) => i.status === "released").length;
                  const projDone = projIssues.filter((i) => i.status === "closed").length;

                  return (
                    <li
                      key={p.slug}
                      className="rounded-lg border border-gray-200 bg-white p-4 transition hover:border-blue-400 hover:shadow-sm"
                    >
                      <div className="flex items-start justify-between">
                        <Link
                          to={`/project/${p.slug}/overview`}
                          className="min-w-0 flex-1 pr-3"
                        >
                          <span className="font-medium text-gray-900">{p.name}</span>
                          {p.description && (
                            <p className="mt-1 text-sm text-gray-500 line-clamp-1">{p.description}</p>
                          )}
                        </Link>
                        <Link
                          to={`/project/${p.slug}/issues/new`}
                          className="shrink-0 rounded bg-gray-900 px-2.5 py-1 text-xs text-white hover:bg-gray-700"
                        >
                          New Issue
                        </Link>
                      </div>
                      <Link
                        to={`/project/${p.slug}/overview`}
                        className="mt-2 flex gap-3 text-xs text-gray-400"
                      >
                        <span>{projOpen} open</span>
                        <span>{projActive} active</span>
                        <span>{projResolved} resolved</span>
                        <span>{projDone} done</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Recent Activity / Search Results */}
          <section>
            <h2 className="mb-3 text-lg font-semibold text-gray-900">
              {search.trim() ? `Search Results (${filteredIssues.length})` : "Recent Activity"}
            </h2>
            {loadingIssues ? (
              <div className="space-y-2">
                {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
              </div>
            ) : filteredIssues.length === 0 ? (
              <EmptyState title={search.trim() ? "No issues match your search." : "No recent activity."} />
            ) : (
              <ul className="space-y-2">
                {(search.trim() ? filteredIssues : recentActivity).map((issue) => (
                  <IssueListItem key={issue.id} issue={issue} to={issue.project ? `/project/${issue.project.slug}/issues` : "#"} />
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Usage */}
        <UsageDashboard />
    </PageShell>
  );
}
