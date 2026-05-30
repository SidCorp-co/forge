"use client";

import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";
import { Kicker } from "@/design/primitives/kicker";
import { ProjectMark } from "@/design/primitives/project-mark";

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
}

export interface NavRailProps {
  workspaceItems: NavItem[];
  projectItems: NavItem[];
  activeKey: string;
  onNavigate?: (key: string) => void;
  project?: { name: string; initials: string; tint: string; ink: string };
  user?: { initials: string };
}

function NavRow({ item, active, onClick }: { item: NavItem; active: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-semibold transition-colors duration-[120ms]",
        active ? "bg-accent-tint text-accent-text" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <Icon name={item.icon} size={17} style={active ? { color: "var(--accent)" } : undefined} />
      {item.label}
    </button>
  );
}

/** Two-tier left nav: Workspace links + a project switcher + project sub-nav. */
export function NavRail({ workspaceItems, projectItems, activeKey, onNavigate, project, user }: NavRailProps) {
  return (
    <nav className="flex h-full w-[232px] flex-none flex-col gap-5 border-r border-line bg-surface px-3 py-4">
      <div className="flex items-center gap-2 px-1.5">
        <span
          className="inline-flex size-7 items-center justify-center rounded-md"
          style={{ background: "var(--flame-500)", color: "#fff" }}
        >
          <Icon name="pipeline" size={17} strokeWidth={2} />
        </span>
        <span className="fg-h3" style={{ fontSize: 16 }}>
          Forge
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <Kicker className="px-2.5 pb-1">Workspace</Kicker>
        {workspaceItems.map((it) => (
          <NavRow key={it.key} item={it} active={it.key === activeKey} onClick={() => onNavigate?.(it.key)} />
        ))}
      </div>

      {project && (
        <div className="flex flex-col gap-1">
          <Kicker className="px-2.5 pb-1">Project</Kicker>
          <button
            type="button"
            className="mb-1 flex items-center gap-2.5 rounded-md border border-line bg-sunken px-2.5 py-2 text-left transition-colors hover:bg-hover"
          >
            <ProjectMark tint={project.tint} ink={project.ink} initials={project.initials} size={26} radius="var(--r-sm)" />
            <span className="fg-label flex-1 truncate">{project.name}</span>
            <Icon name="chevronUpDown" size={15} className="text-subtle" />
          </button>
          {projectItems.map((it) => (
            <NavRow key={it.key} item={it} active={it.key === activeKey} onClick={() => onNavigate?.(it.key)} />
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center gap-2.5 border-t border-line-subtle px-1.5 pt-3">
        <span
          className="inline-flex size-7 items-center justify-center rounded-pill font-bold"
          style={{ background: "var(--cobalt-100)", color: "var(--cobalt-700)", fontSize: 12 }}
        >
          {user?.initials ?? "SK"}
        </span>
        <span className="fg-body-sm flex-1 text-fg">You</span>
        <Icon name="settings" size={16} className="text-subtle" />
      </div>
    </nav>
  );
}
