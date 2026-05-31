"use client";

// Project context = a HORIZONTAL TAB BAR (ISS-307, Concept B). Replaces the
// old clustered project sub-nav that lived in the left rail. Primary tabs route
// via `router.push` so each is deep-linkable; the `More▾` overflow carries the
// lower-traffic surfaces. On mobile the primary row becomes a horizontally
// scrollable strip (no page horizontal-scroll) and More stays a menu.
import { useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Icon, Menu, type MenuItem, Tabs, type TabItem } from "@/design";
import { cn } from "@/lib/utils/cn";

/** Primary tabs. `sub` is appended to `/projects/[slug]`; "" is Overview. */
const PRIMARY: Array<TabItem & { sub: string }> = [
  { value: "", label: "Overview", sub: "" },
  { value: "/issues", label: "Issues", sub: "/issues" },
  { value: "/pipeline", label: "Pipeline", sub: "/pipeline" },
  { value: "/sessions", label: "Sessions", sub: "/sessions" },
];

/** Overflow (`More▾`). project Settings is intentionally omitted — no
 *  project-scoped settings route exists; account/workspace Settings lives on the
 *  rail. Adding a stub here would ship a dead link (see plan risk #1). */
const MORE: Array<{ sub: string; label: string; icon: MenuItem["icon"] }> = [
  { sub: "/pm", label: "PM", icon: "shield" },
  { sub: "/knowledge", label: "Knowledge", icon: "book" },
  { sub: "/memory", label: "Memory", icon: "archive" },
  { sub: "/schedules", label: "Schedules", icon: "calendar" },
  { sub: "/skills", label: "Skills", icon: "star" },
];

/** Match a pathname's project-relative remainder against a tab `sub`. */
function matchesSub(rest: string, sub: string): boolean {
  return sub === "" ? rest === "" : rest === sub || rest.startsWith(`${sub}/`);
}

export function ProjectTabBar({ slug }: { slug: string }) {
  const router = useRouter();
  const pathname = usePathname() || "";

  const rest = useMemo(() => {
    const base = `/projects/${slug}`;
    return pathname.startsWith(base) ? pathname.slice(base.length) : "";
  }, [pathname, slug]);

  // Active primary tab, or null when on an overflow / non-tab route (e.g. the
  // legacy /agent chat) — in which case no primary underline shows.
  const activePrimary = useMemo(() => {
    const hit = PRIMARY.find((t) => matchesSub(rest, t.sub));
    return hit ? hit.value : null;
  }, [rest]);

  // When the route is one of the overflow surfaces, light the More trigger and
  // surface which one (so the user isn't left without an active indicator).
  const activeMore = useMemo(() => MORE.find((m) => matchesSub(rest, m.sub)) ?? null, [rest]);

  const go = (sub: string) => router.push(`/projects/${slug}${sub}`);

  const moreItems: MenuItem[] = MORE.map((m) => ({
    label: m.label,
    icon: m.icon,
    onSelect: () => go(m.sub),
  }));

  return (
    <div className="flex items-stretch px-4 sm:px-6">
      <div className="min-w-0 flex-1 overflow-x-auto">
        {/* `onChange` carries the routed sub-path, so every tab is deep-linkable
            and the browser restores scroll on back (distinct routes). */}
        <Tabs
          tabs={PRIMARY.map(({ value, label }) => ({ value, label }))}
          value={activeMore ? "__more__" : (activePrimary ?? "__none__")}
          onChange={(v) => {
            const hit = PRIMARY.find((t) => t.value === v);
            if (hit) go(hit.sub);
          }}
        />
      </div>
      <Menu
        align="right"
        trigger={
          <button
            type="button"
            aria-label="More project sections"
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap border-b border-line px-3 py-2.5 text-[13.5px] font-semibold transition-colors focus-visible:rounded-sm focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-md:min-h-[44px]",
              activeMore ? "text-fg" : "text-muted hover:text-fg",
            )}
          >
            {activeMore ? activeMore.label : "More"}
            <Icon name="chevronDown" size={14} />
          </button>
        }
        items={moreItems}
      />
    </div>
  );
}
