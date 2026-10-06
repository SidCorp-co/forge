"use client";

import { useMemo, useRef, useState } from "react";
import { Icon, type IconName, Popover, ProjectMark } from "@/design";
import { cn } from "@/lib/utils/cn";

export interface RailProject {
  name: string;
  initials: string;
  tint: string;
  ink: string;
  liveRuns: number;
}

export interface SwitcherProject extends RailProject {
  id: string;
  slug: string;
  pinned: boolean;
}

interface ProjectSwitcherProps {
  compact: boolean;
  /** The project the rail shows; absent, the switcher offers to add one when the org has none. */
  project: RailProject | null | undefined;
  /** The active org's projects. */
  projects: SwitcherProject[];
  activeSlug: string | null;
  onSelect: (slug: string) => void;
  onSettings: (slug: string) => void;
  onTogglePin: (id: string) => void;
  onAllProjects: () => void;
  onNewProject: () => void;
}

/** Pinned first, then by name; the term matches a name or a slug. */
export function switcherRows(projects: SwitcherProject[], query: string): SwitcherProject[] {
  const term = query.trim().toLowerCase();
  return projects
    .filter((p) => !term || p.name.toLowerCase().includes(term) || p.slug.toLowerCase().includes(term))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}

function Trigger({ compact, project, open, onClick }: { compact: boolean; project: RailProject; open: boolean; onClick: () => void }) {
  const label = `Switch project — current ${project.name}`;
  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        className={cn("flex w-[76px] flex-col items-center gap-1 rounded-md pb-1.5 pt-5px transition-colors", open ? "bg-hover" : "hover:bg-hover")}
      >
        <span className="relative">
          <ProjectMark tint={project.tint} ink={project.ink} initials={project.initials} size={30} radius="var(--r-md)" />
          <span
            className="absolute -bottom-[3px] -right-1 inline-flex size-[15px] items-center justify-center rounded-pill text-subtle"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--border-default)" }}
          >
            <Icon name="chevronUpDown" size={9} strokeWidth={2.4} />
          </span>
        </span>
        {project.liveRuns > 0 && <span className="font-mono text-9-5 font-semibold text-accent-text">{project.liveRuns} live</span>}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={label}
      className={cn("flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors", open ? "bg-hover" : "hover:bg-hover")}
    >
      <ProjectMark tint={project.tint} ink={project.ink} initials={project.initials} size={26} radius="var(--r-sm)" />
      <span className="fg-label min-w-0 flex-1 truncate">{project.name}</span>
      {project.liveRuns > 0 && <span className="font-mono text-11 font-semibold text-accent-text">{project.liveRuns} live</span>}
      <Icon name="chevronUpDown" size={15} className="text-subtle" />
    </button>
  );
}

function AddProject({ compact, onClick }: { compact: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Add project"
      className={cn(
        "flex items-center rounded-md text-subtle transition-colors hover:bg-hover",
        compact ? "w-[76px] flex-col gap-1 pb-1.5 pt-5px" : "w-full gap-2.5 px-2.5 py-2",
      )}
    >
      <span className="inline-flex size-7 items-center justify-center rounded-md border border-dashed border-line">
        <Icon name="plus" size={16} />
      </span>
      <span className={compact ? "text-10 font-semibold text-muted" : "fg-label text-muted"}>Add project</span>
    </button>
  );
}

function SwitcherRow({
  project: p,
  active,
  onSelect,
  onSettings,
  onTogglePin,
}: {
  project: SwitcherProject;
  active: boolean;
  onSelect: () => void;
  onSettings: () => void;
  onTogglePin: () => void;
}) {
  const quiet = "inline-flex size-7 flex-none items-center justify-center rounded-md transition-colors hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]";
  return (
    <div className={cn("group flex min-h-[40px] items-center gap-2.5 rounded-md px-2 py-1", active ? "bg-accent-tint" : "hover:bg-hover")}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none"
      >
        <ProjectMark tint={p.tint} ink={p.ink} initials={p.initials} size={22} radius="var(--r-sm)" />
        <span className={cn("min-w-0 flex-1 truncate text-13 font-semibold", active ? "text-accent-text" : "text-fg")}>{p.name}</span>
        {p.liveRuns > 0 && <span title={`${p.liveRuns} live`} className="size-1.5 flex-none rounded-pill" style={{ background: "var(--accent)" }} />}
      </button>
      <button type="button" onClick={onSettings} aria-label={`${p.name} settings`} className={cn(quiet, "text-subtle opacity-0 group-hover:opacity-100")}>
        <Icon name="settings" size={15} />
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        aria-label={p.pinned ? `Unpin ${p.name}` : `Pin ${p.name}`}
        aria-pressed={p.pinned}
        className={cn(quiet, p.pinned ? "text-accent-text" : "text-subtle opacity-0 group-hover:opacity-100")}
      >
        <Icon name="pin" size={15} strokeWidth={p.pinned ? 2.4 : 1.75} />
      </button>
    </div>
  );
}

function Action({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[36px] w-full items-center gap-2.5 rounded-md px-2 text-left text-13 font-semibold text-muted transition-colors hover:bg-hover hover:text-fg"
    >
      <Icon name={icon} size={15} className="text-subtle" />
      {label}
    </button>
  );
}

/** The rail's one project switcher, for both widths: hover or click opens a searchable list of the active org's projects beside the rail. */
export function ProjectSwitcher(props: ProjectSwitcherProps) {
  const { compact, project, projects, activeSlug } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => switcherRows(projects, query), [projects, query]);

  if (!project) return projects.length === 0 ? <AddProject compact={compact} onClick={props.onNewProject} /> : null;

  const hold = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  const show = () => {
    hold();
    setOpen(true);
  };
  const close = () => {
    hold();
    setOpen(false);
    setQuery("");
  };
  const leave = () => {
    hold();
    timer.current = setTimeout(close, 150);
  };
  const then = (act: () => void) => () => {
    close();
    act();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only keeps the list open for a pointer; the button inside opens it from the keyboard
    <div ref={anchor} className={compact ? "relative" : "relative w-full"} onMouseEnter={show} onMouseLeave={leave}>
      <Trigger compact={compact} project={project} open={open} onClick={() => (open ? close() : show())} />
      <Popover
        open={open}
        anchor={anchor}
        onDismiss={close}
        placement="right-start"
        gap={compact ? 10 : 6}
        role="dialog"
        aria-label="Switch project"
        className="flex w-[300px] flex-col rounded-lg border border-line bg-surface shadow-[var(--shadow-lg)]"
      >
        <div className="flex items-center gap-2 border-b border-line-subtle px-3 py-2">
          <Icon name="search" size={14} className="text-subtle" />
          <input
            ref={(el) => el?.focus()}
            aria-label="Find a project"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a project…"
            className="flex-1 border-none bg-transparent py-0.5 text-13 text-fg outline-none placeholder:text-disabled"
          />
        </div>
        <div className="max-h-[300px] min-h-0 overflow-y-auto p-1.5">
          {rows.map((p) => (
            <SwitcherRow
              key={p.id}
              project={p}
              active={p.slug === activeSlug}
              onSelect={then(() => props.onSelect(p.slug))}
              onSettings={then(() => props.onSettings(p.slug))}
              onTogglePin={() => props.onTogglePin(p.id)}
            />
          ))}
          {rows.length === 0 && <p className="px-2 py-3 text-13 text-muted">No projects match.</p>}
        </div>
        <div className="flex flex-col border-t border-line-subtle p-1.5">
          <Action icon="folder" label="View all" onClick={then(props.onAllProjects)} />
          <Action icon="plus" label="New project" onClick={then(props.onNewProject)} />
        </div>
      </Popover>
    </div>
  );
}
