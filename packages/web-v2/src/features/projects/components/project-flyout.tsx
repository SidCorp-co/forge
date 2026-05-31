"use client";

// Searchable project switcher (Concept C, ISS-307). Opened from the rail's
// project mark (NavRail `onProjectSwitch`). A self-contained floating panel:
// search input + pinned-first project list with per-row pin toggle + an
// "All projects" escape hatch. Closes on click-away or Esc. Controlled by the
// workspace layout via `open` / `onClose`.
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, Input, ProjectMark } from "@/design";
import { cn } from "@/lib/utils/cn";
import { useProjects } from "@/features/projects/hooks";
import { usePinnedProjects } from "@/features/projects/pins";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";

export function ProjectFlyout({
  open,
  onClose,
  activeSlug,
}: {
  open: boolean;
  onClose: () => void;
  activeSlug?: string | null;
}) {
  const router = useRouter();
  const { data: projects } = useProjects();
  const { pinnedIds, toggle } = usePinnedProjects();
  const [q, setQ] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

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

  // Pinned-first ordering, then a case-insensitive name/slug filter.
  const rows = useMemo(() => {
    const list = projects ?? [];
    const term = q.trim().toLowerCase();
    const filtered = term
      ? list.filter(
          (p) => p.name.toLowerCase().includes(term) || p.slug.toLowerCase().includes(term),
        )
      : list;
    return [...filtered].sort((a, b) => {
      const ap = pinnedIds.has(a.id) ? 0 : 1;
      const bp = pinnedIds.has(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.name.localeCompare(b.name);
    });
  }, [projects, q, pinnedIds]);

  if (!open) return null;

  const goProject = (slug: string) => {
    onClose();
    router.push(`/projects/${slug}`);
  };

  return (
    <>
      {/* Click-away catcher. */}
      <button
        type="button"
        aria-label="Close project switcher"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Switch project"
        className="forge-slide fixed bottom-4 left-[68px] z-50 flex max-h-[70vh] w-[300px] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow-lg)] md:left-[240px]"
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
          <button
            type="button"
            onClick={() => {
              onClose();
              router.push("/");
            }}
            className="flex min-h-[40px] w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] font-semibold text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <span className="inline-flex size-6 flex-none items-center justify-center rounded-sm bg-sunken text-subtle">
              <Icon name="grid" size={15} />
            </span>
            <span className="flex-1">All projects</span>
          </button>

          {rows.map((p) => {
            const g = projectGlyph(p.id);
            const active = p.slug === activeSlug;
            const pinned = pinnedIds.has(p.id);
            return (
              <div
                key={p.id}
                className={cn(
                  "group flex min-h-[40px] items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors",
                  active ? "bg-accent-tint" : "hover:bg-hover",
                )}
              >
                <button
                  type="button"
                  onClick={() => goProject(p.slug)}
                  aria-current={active ? "page" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none"
                >
                  <ProjectMark
                    tint={g.tint}
                    ink={g.ink}
                    initials={projectInitials(p.name)}
                    size={24}
                    radius="var(--r-sm)"
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[13.5px] font-semibold",
                      active ? "text-accent-text" : "text-fg",
                    )}
                  >
                    {p.name}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => toggle(p.id)}
                  aria-label={pinned ? `Unpin ${p.name}` : `Pin ${p.name}`}
                  aria-pressed={pinned}
                  className={cn(
                    "inline-flex size-7 flex-none items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
                    pinned
                      ? "text-accent-text"
                      : "text-subtle opacity-0 hover:text-fg group-hover:opacity-100",
                  )}
                >
                  <Icon name="pin" size={15} />
                </button>
              </div>
            );
          })}

          {rows.length === 0 && (
            <p className="fg-body-sm px-2.5 py-3 text-muted">No projects match.</p>
          )}
        </div>
      </div>
    </>
  );
}
