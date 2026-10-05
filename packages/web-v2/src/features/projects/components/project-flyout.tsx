"use client";

// Searchable project switcher (Concept C, ISS-307; project-first ISS-358).
// Opened from the rail's project mark (NavRail `onProjectSwitch`) on click or
// hover. A self-contained floating panel anchored to the top of the rail:
// search input + pinned-first project list with per-row pin toggle + "View all"
// and "Create project" actions. Closes on mouse-leave, click-away, or Esc.
// Controlled by the workspace layout via `open` / `onClose`.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName, Input, ProjectMark } from "@/design";
import { cn } from "@/lib/utils/cn";
import { projectGlyph, projectInitials } from "../glyph";
import { useProjects } from "../hooks";
import { usePinnedProjects } from "../pins";
import type { ProjectListItem } from "../types";

export function ProjectFlyout({
  open,
  onClose,
  activeSlug,
  onPanelEnter,
  onPanelLeave,
  onViewAll,
  onCreateProject,
}: {
  open: boolean;
  onClose: () => void;
  activeSlug?: string | null;
  /** Hover handlers so the panel keeps the switcher's flyout open while the
   *  pointer is over it, and schedules close on leave. */
  onPanelEnter?: () => void;
  onPanelLeave?: () => void;
  /** "View all" → workspace overview / all-projects page. */
  onViewAll?: () => void;
  /** "Create project" → create-project flow. */
  onCreateProject?: () => void;
}) {
  const router = useRouter();
  const { data: projects } = useProjects();
  const { pinnedIds, toggle } = usePinnedProjects();
  const [q, setQ] = useState("");

  // Reset the query each time the flyout opens.
  useEffect(() => {
    if (open) setQ("");
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Pinned-first ordering, then a case-insensitive name/slug filter.
  const term = q.trim().toLowerCase();
  const rank = (id: string) => (pinnedIds.has(id) ? 0 : 1);
  const rows = (projects ?? [])
    .filter((p) => !term || p.name.toLowerCase().includes(term) || p.slug.toLowerCase().includes(term))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));

  const go = (href: string, instead?: () => void) => {
    onClose();
    if (instead) instead();
    else router.push(href);
  };

  return (
    <>
      {/* Click-away catcher. Starts at the rail's right edge (left-[280px]) so it
          never overlays the switcher trigger inside the rail — otherwise the
          overlay steals the pointer the moment the flyout opens, firing the
          trigger's mouseleave and flickering the panel closed/open (ISS-359).
          The panel itself (z-50) still sits above this catcher. */}
      <button
        type="button"
        aria-label="Close project switcher"
        className="fixed inset-y-0 right-0 left-[280px] z-40 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Switch project"
        onMouseEnter={onPanelEnter}
        onMouseLeave={onPanelLeave}
        // Anchored flush to the expanded rail's right edge (rail is w-[280px]) so
        // there is no dead gap for the pointer to cross between trigger and panel.
        className="forge-slide fixed top-[60px] left-[280px] z-50 flex max-h-[70vh] w-[300px] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow-lg)]"
      >
        <div className="border-b border-line-subtle p-2">
          <Input
            icon="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects…"
            autoFocus
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.map((p) => (
            <FlyoutRow
              key={p.id}
              project={p}
              active={p.slug === activeSlug}
              pinned={pinnedIds.has(p.id)}
              onGo={go}
              onTogglePin={() => toggle(p.id)}
            />
          ))}

          {rows.length === 0 && (
            <p className="fg-body-sm px-2.5 py-3 text-muted">No projects match.</p>
          )}
        </div>

        {/* Actions pinned below the list (mirrors the compact rail). */}
        <div className="flex flex-col gap-0.5 border-t border-line-subtle p-1.5">
          <FlyoutAction icon="folder" label="View all" onClick={() => go("/projects", onViewAll)} />
          <FlyoutAction icon="plus" label="Create project" onClick={() => go("/projects?new=1", onCreateProject)} />
        </div>
      </div>
    </>
  );
}

function FlyoutRow({
  project: p,
  active,
  pinned,
  onGo,
  onTogglePin,
}: {
  project: ProjectListItem;
  active: boolean;
  pinned: boolean;
  onGo: (href: string) => void;
  onTogglePin: () => void;
}) {
  const g = projectGlyph(p.id);
  return (
    <div
      className={cn(
        "group flex min-h-[40px] items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors",
        active ? "bg-accent-tint" : "hover:bg-hover",
      )}
    >
      <button
        type="button"
        onClick={() => onGo(`/projects/${p.slug}`)}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none"
      >
        <ProjectMark tint={g.tint} ink={g.ink} initials={projectInitials(p.name)} size={24} radius="var(--r-sm)" />
        <span
          className={cn("min-w-0 flex-1 truncate text-13-5 font-semibold", active ? "text-accent-text" : "text-fg")}
        >
          {p.name}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onGo(`/projects/${p.slug}/settings`)}
        aria-label={`${p.name} settings`}
        className="inline-flex size-7 flex-none items-center justify-center rounded-md text-subtle opacity-0 transition-colors hover:text-fg focus-visible:opacity-100 focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none group-hover:opacity-100"
      >
        <Icon name="settings" size={15} />
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        aria-label={pinned ? `Unpin ${p.name}` : `Pin ${p.name}`}
        aria-pressed={pinned}
        className={cn(
          "inline-flex size-7 flex-none items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
          pinned ? "text-accent-text" : "text-subtle opacity-0 hover:text-fg group-hover:opacity-100",
        )}
      >
        <Icon name="pin" size={15} />
      </button>
    </div>
  );
}

function FlyoutAction({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[40px] w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-13-5 font-semibold text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
    >
      <span className="inline-flex size-6 flex-none items-center justify-center rounded-sm bg-sunken text-subtle">
        <Icon name={icon} size={15} />
      </span>
      <span className="flex-1">{label}</span>
    </button>
  );
}
