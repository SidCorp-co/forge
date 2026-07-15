"use client";

// Mobile drawer — the consolidated navigation menu (ISS-514): the active
// project's tier (PROJECT_ITEMS), the workspace destinations, and the project
// switcher. Opened from the TopBar menu button, below md. Stays mounted while
// closed (the Esc listener is gated on `open`); the layout owns the open
// state and closes it on route change.
import { useEffect } from "react";
import { Icon, ProjectMark } from "@/design";
import { OrgSwitcher } from "@/features/orgs/components/org-switcher";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import type { ProjectListItem } from "@/features/projects/types";
import { cn } from "@/lib/utils/cn";
import { PROJECT_ITEMS, SECONDARY_DESTINATIONS, WORKSPACE_ITEMS } from "../nav-model";

// Workspace destinations for the mobile drawer: the rail rows plus the two
// most-wanted secondary destinations (Attention, Settings), so the workspace
// tier stays reachable from inside a project once the bottom bar shows the
// project tier (ISS-514). Routed via their key through onNavigate().
const DRAWER_WORKSPACE_ITEMS = [
  ...WORKSPACE_ITEMS,
  SECONDARY_DESTINATIONS.find((it) => it.key === "attention")!,
  SECONDARY_DESTINATIONS.find((it) => it.key === "settings")!,
];

/** One 44px drawer nav row — icon/mark + label + optional count pill. */
function DrawerNavButton({
  active,
  onClick,
  leading,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  leading: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
        active ? "bg-accent-tint text-accent-text" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && badge > 0 && (
        <span className="fg-caption rounded-pill bg-app px-1.5 text-muted">{badge}</span>
      )}
    </button>
  );
}

export interface MobileNavDrawerProps {
  open: boolean;
  onClose: () => void;
  /** True when opened from the bottom-nav "Project switcher" tab — renders the
   *  Projects section first so it's reachable without scrolling past This
   *  project/Workspace (ISS-685). Default `false` (TopBar menu button) keeps
   *  the original This project -> Workspace -> Projects order. */
  projectFirst?: boolean;
  /** Active project slug from the pathname (null on workspace screens). */
  slug: string | null;
  /** The project the rail renders (active, else last-visited, else first). */
  railSlug: string | null;
  railProjectName: string | null | undefined;
  activeKey: string;
  attentionCount: number;
  /** Open-issue count for the rail project (badges the Issues row). */
  openIssuesBadge: number | undefined;
  /** Projects scoped to the active org (ISS-480). */
  scopedProjects: ProjectListItem[];
  /** Shared key-router from the layout (workspace + proj-* keys). */
  onNavigate: (key: string) => void;
  onOpenProject: (slug: string) => void;
  onCreateProject: () => void;
  onViewAllProjects: () => void;
}

export function MobileNavDrawer({
  open,
  onClose,
  projectFirst = false,
  slug,
  railSlug,
  railProjectName,
  activeKey,
  attentionCount,
  openIssuesBadge,
  scopedProjects,
  onNavigate,
  onOpenProject,
  onCreateProject,
  onViewAllProjects,
}: MobileNavDrawerProps) {
  // Esc closes the mobile drawer.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // This project — the project tier from the desktop rail. Shown for the rail
  // project (the one you're in, else last-visited) so Issues & co. are always
  // reachable on mobile.
  const thisProjectSection = railSlug && (
    <>
      <span className="fg-label px-1.5 pb-1 pt-0.5 text-fg">
        {railProjectName ?? "This project"}
      </span>
      {PROJECT_ITEMS.map((it) => (
        <DrawerNavButton
          key={it.key}
          active={it.key === activeKey}
          onClick={() => {
            onNavigate(it.key);
            onClose();
          }}
          leading={<Icon name={it.icon} size={18} />}
          label={it.label}
          badge={it.key === "proj-issues" ? openIssuesBadge : undefined}
        />
      ))}
    </>
  );

  // Workspace — destinations consolidated into the menu so the tier stays
  // reachable once the bottom bar shows the project tier.
  const workspaceSection = (
    <>
      <span className="fg-label px-1.5 pb-1 pt-2 text-fg">Workspace</span>
      {DRAWER_WORKSPACE_ITEMS.map((it) => (
        <DrawerNavButton
          key={it.key}
          active={!slug && it.key === activeKey}
          onClick={() => {
            onNavigate(it.key);
            onClose();
          }}
          leading={<Icon name={it.icon} size={18} />}
          label={it.label}
          badge={it.key === "attention" ? attentionCount : undefined}
        />
      ))}
    </>
  );

  // Projects switcher (unchanged behaviour — do not regress).
  const projectsSection = (
    <>
      <div className="flex items-center justify-between px-1.5 pb-1 pt-2">
        <span className="fg-label text-fg">Projects</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onCreateProject}
            className="fg-caption inline-flex items-center gap-1 rounded-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <Icon name="plus" size={13} />
            Create
          </button>
          <button
            type="button"
            onClick={onViewAllProjects}
            className="fg-caption rounded-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            View all
          </button>
        </div>
      </div>
      {scopedProjects.map((p) => {
        const g = projectGlyph(p.id);
        return (
          <DrawerNavButton
            key={p.id}
            active={p.slug === slug}
            onClick={() => onOpenProject(p.slug)}
            leading={
              <ProjectMark tint={g.tint} ink={g.ink} initials={projectInitials(p.name)} size={24} radius="var(--r-sm)" />
            }
            label={p.name}
          />
        );
      })}
      {scopedProjects.length === 0 && (
        <p className="fg-body-sm px-1.5 py-2 text-muted">No projects yet.</p>
      )}
    </>
  );

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label="Close navigation"
        className="fixed inset-0 z-40 cursor-default"
        style={{ background: "rgba(24,27,34,0.4)" }}
        onClick={onClose}
      />
      <div
        className="forge-slide fixed inset-y-0 left-0 z-50 flex w-[272px] max-w-[82vw] flex-col gap-1 border-r border-line bg-surface p-3 pb-[env(safe-area-inset-bottom)] pt-[max(env(safe-area-inset-top),0.75rem)]"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        {/* Org context + switcher (ISS-469) — the rail is hidden below md,
            so the drawer carries the current-org control on mobile. */}
        <div className="px-1.5 pb-3">
          <OrgSwitcher variant="expanded" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {projectFirst ? (
            <>
              {projectsSection}
              {thisProjectSection}
              {workspaceSection}
            </>
          ) : (
            <>
              {thisProjectSection}
              {workspaceSection}
              {projectsSection}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
