// web-v2 shell feature module — the ⌘K command registry. Pure builder: the
// workspace layout memoizes the result; every entry is wired to existing
// handlers/routes only (no fabricated endpoints).
import type { Command, ToastView } from "@/design";
import type { ProjectListItem } from "@/features/projects/types";
import { PROJECT_ITEMS, SECONDARY_DESTINATIONS, WORKSPACE_ITEMS } from "./nav-model";
import type { PinnedView } from "@/lib/navigation/pinned-views";
import type { RecentEntry } from "@/lib/navigation/recents";

interface WorkspaceCommandDeps {
  router: { push: (href: string) => void };
  /** Active project slug (null outside a project). */
  slug: string | null;
  onNewChat: () => void;
  /** Active project's display name (falls back to `slug` in labels). */
  activeProjectName: string | null | undefined;
  /** Projects scoped to the active org (ISS-477/480). */
  scopedProjects: ProjectListItem[];
  pinnedIds: Set<string>;
  pinnedViews: PinnedView[];
  recents: RecentEntry[];
  toast: (t: ToastView & { duration?: number }) => void;
}

export function buildWorkspaceCommands(deps: WorkspaceCommandDeps): Command[] {
  const { router, slug, activeProjectName, scopedProjects, pinnedIds, pinnedViews, recents, toast, onNewChat } = deps;
  const go = (label: string, icon: Command["icon"], group: Command["group"], href: string, keywords?: string): Command => ({
    label,
    icon,
    group,
    ...(keywords ? { keywords } : {}),
    onRun: () => router.push(href),
  });
  const project = activeProjectName ?? slug;
  // Where a run is dispatched or cancelled: the project's pipeline, else the ops view.
  const pipelineHref = slug ? `/projects/${slug}/pipeline` : "/ops";

  // ISS-477 — project results are scoped to the active org, so the palette never surfaces projects
  // from another org while one is selected.
  return [
    ...recents.map((r) => go(r.label, r.icon ?? "clock", "recent", r.href, r.kind)),
    ...scopedProjects
      .filter((p) => pinnedIds.has(p.id))
      .map((p) => go(p.name, "pin", "pinned", `/projects/${p.slug}`, "project")),
    ...pinnedViews.map((v) => go(v.label, v.icon, "pinned", v.href, "view")),
    ...WORKSPACE_ITEMS.map((it) => go(it.label, it.icon, "navigate", it.href)),
    // The secondary destinations dropped from the rail, so deep nav stays reachable.
    ...SECONDARY_DESTINATIONS.map((it) => go(it.label, it.icon, "navigate", it.href, "go to")),
    go("Docs", "book", "navigate", "/docs", "help documentation guides go to"),
    go("All projects", "folder", "navigate", "/projects", "projects list console go to"),
    ...scopedProjects.map((p) => go(`Switch to ${p.name}`, "folder", "navigate", `/projects/${p.slug}`, "project switch")),
    ...(slug
      ? [
          ...PROJECT_ITEMS.map((it) => go(`${project} · ${it.label}`, it.icon, "navigate", `/projects/${slug}${it.sub}`)),
          // The rail names only Automation (ISS-65); its Schedules tab is reachable by name.
          go(`${project} · Schedules`, "clock", "navigate", `/projects/${slug}/automation?tab=schedules`),
          // Project settings (ISS-316), a nested route kept off the rail.
          go(
            `${project} · Settings`,
            "settings",
            "navigate",
            `/projects/${slug}/settings`,
            "project settings config repo branch members labels pipeline",
          ),
        ]
      : []),
    { label: "New chat", icon: "chat", group: "actions", keywords: "ask agent assistant conversation", onRun: onNewChat },
    {
      label: "Create issue",
      icon: "plus",
      group: "actions",
      keywords: "new issue",
      onRun: () =>
        slug
          ? router.push(`/projects/${slug}/issues?new=1`)
          : toast({ title: "New issue", description: "Open a project to create an issue.", tone: "info" }),
    },
    go("Dispatch pipeline", "pipeline", "actions", pipelineHref, "run dispatch"),
    go("Pair device", "server", "actions", "/runners", "runner device"),
    go("Cancel a run", "stop", "actions", pipelineHref, "cancel run abort"),
  ];
}
