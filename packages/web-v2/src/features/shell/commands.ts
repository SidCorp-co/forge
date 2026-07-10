// web-v2 shell feature module — the ⌘K command registry. Pure builder: the
// workspace layout memoizes the result; every entry is wired to existing
// handlers/routes only (no fabricated endpoints).
import type { Command, ToastView } from "@/design";
import type { ProjectListItem } from "@/features/projects/types";
import { PROJECT_ITEMS, SECONDARY_DESTINATIONS, WORKSPACE_ITEMS } from "./nav-model";
import type { PinnedView } from "./pinned-views";
import type { RecentEntry } from "./recents";

export interface WorkspaceCommandDeps {
  router: { push: (href: string) => void };
  /** Active project slug (null outside a project). */
  slug: string | null;
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
  const { router, slug, activeProjectName, scopedProjects, pinnedIds, pinnedViews, recents, toast } = deps;
  const out: Command[] = [];

  // ISS-477 — ⌘K project results are scoped to the active org (reuses the
  // component-level `scopedProjects`) so the palette never surfaces projects
  // from another org while one is selected (matches every other SPACE surface).

  // Recent — recently-viewed entities.
  for (const r of recents) {
    out.push({
      label: r.label,
      icon: r.icon ?? "clock",
      group: "recent",
      keywords: r.kind,
      onRun: () => router.push(r.href),
    });
  }

  // Pinned — pinned projects + pinned views.
  for (const p of scopedProjects) {
    if (!pinnedIds.has(p.id)) continue;
    out.push({
      label: p.name,
      icon: "pin",
      group: "pinned",
      keywords: "project",
      onRun: () => router.push(`/projects/${p.slug}`),
    });
  }
  for (const v of pinnedViews) {
    out.push({
      label: v.label,
      icon: v.icon,
      group: "pinned",
      keywords: "view",
      onRun: () => router.push(v.href),
    });
  }

  // Navigate — workspace rail items + the secondary destinations dropped from
  // the rail (so deep nav stays reachable) + project switcher + project sub-nav.
  for (const it of WORKSPACE_ITEMS) {
    out.push({ label: it.label, icon: it.icon, group: "navigate", onRun: () => router.push(it.href) });
  }
  for (const it of SECONDARY_DESTINATIONS) {
    out.push({ label: it.label, icon: it.icon, group: "navigate", keywords: "go to", onRun: () => router.push(it.href) });
  }
  out.push({
    label: "What's New",
    icon: "bell",
    group: "navigate",
    keywords: "changelog release notes updates go to",
    onRun: () => router.push("/whats-new"),
  });
  out.push({
    label: "Docs",
    icon: "book",
    group: "navigate",
    keywords: "help documentation guides go to",
    onRun: () => router.push("/docs"),
  });
  // The project list moved off the landing route to /projects (ISS-355) — keep
  // it reachable from ⌘K (the rail flyout/mobile drawer cover the pointer path).
  out.push({
    label: "All projects",
    icon: "folder",
    group: "navigate",
    keywords: "projects list console go to",
    onRun: () => router.push("/projects"),
  });
  for (const p of scopedProjects) {
    out.push({
      label: `Switch to ${p.name}`,
      icon: "folder",
      group: "navigate",
      keywords: "project switch",
      onRun: () => router.push(`/projects/${p.slug}`),
    });
  }
  if (slug) {
    for (const it of PROJECT_ITEMS) {
      out.push({
        label: `${activeProjectName ?? slug} · ${it.label}`,
        icon: it.icon,
        group: "navigate",
        onRun: () => router.push(`/projects/${slug}${it.sub}`),
      });
    }
    // Project settings (ISS-316) — a nested route kept off the rail, reachable
    // via the dashboard gear and here.
    out.push({
      label: `${activeProjectName ?? slug} · Settings`,
      icon: "settings",
      group: "navigate",
      keywords: "project settings config repo branch members labels pipeline",
      onRun: () => router.push(`/projects/${slug}/settings`),
    });
  }

  // Actions — wired to existing handlers/routes only; no fabricated endpoints.
  out.push({
    label: "Create issue",
    icon: "plus",
    group: "actions",
    keywords: "new issue",
    onRun: () =>
      slug
        ? router.push(`/projects/${slug}/issues?new=1`)
        : toast({ title: "New issue", description: "Open a project to create an issue.", tone: "info" }),
  });
  out.push({
    label: "Dispatch pipeline",
    icon: "pipeline",
    group: "actions",
    keywords: "run dispatch",
    onRun: () => (slug ? router.push(`/projects/${slug}/pipeline`) : router.push("/ops")),
  });
  out.push({
    label: "Pair device",
    icon: "server",
    group: "actions",
    keywords: "runner device",
    onRun: () => router.push("/runners"),
  });
  out.push({
    label: "Cancel a run",
    icon: "stop",
    group: "actions",
    keywords: "cancel run abort",
    onRun: () => (slug ? router.push(`/projects/${slug}/pipeline`) : router.push("/ops")),
  });

  return out;
}
