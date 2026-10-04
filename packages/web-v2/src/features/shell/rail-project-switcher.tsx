"use client";

// The project mark at the top of the compact rail: hover or click opens a searchable switcher
// flyout (pinned first, pin toggles) anchored to the right of the rail.
import { useCallback, useMemo, useRef, useState } from "react";
import { Icon } from "@/design/icons/icon";
import { Popover } from "@/design/primitives/popover";
import { ProjectMark } from "@/design/primitives/project-mark";
import { cn } from "@/lib/utils/cn";
import type { SwitcherProject } from "./nav-rail-compact";

export function RailProjectSwitcher({
  activeProject,
  activeSlug,
  switcherProjects,
  onSelectProject,
  onTogglePin,
  onAllProjects,
  onNewProject,
}: {
  activeProject: { name: string; initials: string; tint: string; ink: string; liveRuns: number };
  activeSlug?: string | null;
  switcherProjects: SwitcherProject[];
  onSelectProject: (slug: string) => void;
  onTogglePin: (id: string) => void;
  onAllProjects: () => void;
  onNewProject: () => void;
}) {
  const [flyOpen, setFlyOpen] = useState(false);
  const [q, setQ] = useState("");
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const switcherRef = useRef<HTMLDivElement>(null);

  const show = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setFlyOpen(true);
  }, []);
  const hide = useCallback(() => {
    closeTimer.current = setTimeout(() => setFlyOpen(false), 150);
  }, []);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const filtered = term
      ? switcherProjects.filter((p) => p.name.toLowerCase().includes(term))
      : switcherProjects;
    return [...filtered].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [switcherProjects, q]);

  const selectProject = (slug: string) => {
    setFlyOpen(false);
    onSelectProject(slug);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only keeps the flyout open for a pointer; the button inside opens it from the keyboard
    <div ref={switcherRef} className="relative" onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        onClick={show}
        aria-haspopup="dialog"
        aria-expanded={flyOpen}
        aria-label={`Switch project — current ${activeProject.name}`}
        className={cn(
          'flex w-[76px] flex-col items-center gap-1 rounded-md pb-1.5 pt-5px transition-colors',
          flyOpen ? 'bg-hover' : 'hover:bg-hover',
        )}
      >
        <span className="relative">
          <ProjectMark
            tint={activeProject.tint}
            ink={activeProject.ink}
            initials={activeProject.initials}
            size={30}
            radius="var(--r-md)"
          />
          <span
            className="absolute -bottom-[3px] -right-1 inline-flex size-[15px] items-center justify-center rounded-pill text-subtle"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
          >
            <Icon name="chevronUpDown" size={9} strokeWidth={2.4} />
          </span>
        </span>
        {activeProject.liveRuns > 0 && (
          <span className="font-mono text-9-5 font-semibold text-accent-text">
            {activeProject.liveRuns} live
          </span>
        )}
      </button>

      <Popover
        open={flyOpen}
        anchor={switcherRef}
        onDismiss={() => setFlyOpen(false)}
        placement="right-start"
        gap={10}
        role="dialog"
        aria-label="Switch project"
        className="w-64 rounded-lg border border-line bg-surface p-[7px] shadow-[var(--shadow-lg)]"
      >
        <ProjectFlyoutBody
          rows={rows}
          q={q}
          onQuery={setQ}
          activeSlug={activeSlug}
          onSelect={selectProject}
          onTogglePin={onTogglePin}
          onAllProjects={() => {
            setFlyOpen(false);
            onAllProjects();
          }}
          onNewProject={() => {
            setFlyOpen(false);
            onNewProject();
          }}
        />
      </Popover>
    </div>
  );
}

function ProjectFlyoutBody({
  rows,
  q,
  onQuery,
  activeSlug,
  onSelect,
  onTogglePin,
  onAllProjects,
  onNewProject,
}: {
  rows: SwitcherProject[];
  q: string;
  onQuery: (q: string) => void;
  activeSlug?: string | null;
  onSelect: (slug: string) => void;
  onTogglePin: (id: string) => void;
  onAllProjects: () => void;
  onNewProject: () => void;
}) {
  return (
    <>
    {/* Diamond arrow on the left edge. */}
    <span
      aria-hidden
      className="absolute left-[-6px] top-[22px] size-[11px] rotate-45"
      style={{
        background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border-default)',
        borderBottom: '1px solid var(--border-default)',
      }}
    />
    <div className="mb-1 flex items-center gap-[7px] border-b border-line-subtle px-2 py-1.5">
      <Icon name="search" size={14} className="text-subtle" />
      <input
        // the flyout opens to type in: focus lands in its search as it mounts
        ref={(el) => el?.focus()}
        aria-label="Find a project"
        value={q}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Find a project…"
        className="flex-1 border-none bg-transparent py-0.5 text-13 text-fg outline-none placeholder:text-disabled"
      />
    </div>
    <div className="max-h-[300px] overflow-y-auto">
      {rows.map((p) => (
        <div
          key={p.id}
          className={cn(
            'flex w-full items-center gap-[9px] rounded-sm px-2 py-[7px]',
            p.slug === activeSlug ? 'bg-accent-tint' : 'hover:bg-hover',
          )}
        >
          <button
            type="button"
            onClick={() => onSelect(p.slug)}
            className="flex min-w-0 flex-1 items-center gap-[9px] text-left focus-visible:outline-none"
          >
            <ProjectMark tint={p.tint} ink={p.ink} initials={p.initials} size={20} radius="var(--r-sm)" />
            <span className="min-w-0 flex-1 truncate text-13 font-medium text-fg">{p.name}</span>
            {p.liveRuns > 0 && (
              <span className="size-1.5 flex-none rounded-pill" style={{ background: 'var(--accent)' }} />
            )}
          </button>
          <button
            type="button"
            onClick={() => onTogglePin(p.id)}
            aria-label={p.pinned ? `Unpin ${p.name}` : `Pin ${p.name}`}
            aria-pressed={p.pinned}
            className={cn(
              'flex flex-none rounded-xs p-3px transition-colors hover:bg-active',
              p.pinned ? 'text-accent' : 'text-disabled hover:text-fg',
            )}
          >
            <Icon name="pin" size={14} strokeWidth={p.pinned ? 2.4 : 1.75} />
          </button>
        </div>
      ))}
      {rows.length === 0 && (
        <p className="px-2 py-3 text-13 text-muted">No projects match.</p>
      )}
    </div>
    <div className="my-1.5 mx-1 h-px bg-[color:var(--border-subtle)]" />
    <button
      type="button"
      onClick={onAllProjects}
      className="flex w-full items-center gap-2.5 rounded-sm p-2 text-13 font-medium text-fg hover:bg-hover"
    >
      <Icon name="folder" size={16} className="text-subtle" />
      View all
    </button>
    <button
      type="button"
      onClick={onNewProject}
      className="flex w-full items-center gap-2.5 rounded-sm p-2 text-13 font-medium text-fg hover:bg-hover"
    >
      <Icon name="plus" size={16} className="text-subtle" />
      New project
    </button>
    </>
  );
}
