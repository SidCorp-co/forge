"use client";

// Global org switcher (ISS-469) — the always-visible "current org" control in
// the app chrome. Reads the active-org context and renders:
//   • the active org name (AC1),
//   • a dropdown of all orgs, personal-first then alpha, selectable (AC2),
//   • a "Manage organizations" entry → Settings → Orgs (AC6, reuses ISS-468),
//   • a static, non-interactive label when the user has a single org (AC5).
// `compact` (narrow rail) is the org's mark; `expanded` (wide rail, mobile drawer)
// prints the whole name. Presentational beyond the context read.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/design/icons/icon";
import { ProjectMark } from "@/design/primitives/project-mark";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { Menu, type MenuItem } from "@/design/patterns/menu";
import { cn } from "@/lib/utils/cn";
import { useActiveOrg } from "../active-org";
import { workspaceName } from "../workspace-name";

export function OrgSwitcher({ variant }: { variant: "compact" | "expanded" }) {
  const router = useRouter();
  const { orgs, activeOrg, setActiveOrg, isSingle } = useActiveOrg();

  // Nothing to show until orgs resolve (avoids a flash of an empty control).
  if (!activeOrg) return null;

  const label = workspaceName(activeOrg);

  const items: MenuItem[] = [
    ...orgs.map((o) => ({
      label: workspaceName(o),
      icon: o.id === activeOrg.id ? ("check" as const) : undefined,
      onSelect: () => setActiveOrg(o.id),
    })),
    // Org home (ISS-470) — the active org's projects + members, one click away.
    { label: "Organization home", icon: "grid", onSelect: () => router.push("/org") },
    { label: "Manage organizations", icon: "settings", onSelect: () => router.push("/settings?tab=orgs") },
  ];

  if (variant === "compact") {
    // The narrow rail never grows with the name (ISS-1229 r46): the name is the tooltip and accessible name.
    const { tint, ink } = projectGlyph(activeOrg.id);
    const mark = (
      <span className="relative inline-flex" data-testid="org-mark">
        <ProjectMark tint={tint} ink={ink} initials={projectInitials(label)} size={30} radius="var(--r-pill)" />
        {!isSingle && (
          <span
            className="absolute -bottom-[3px] -right-1 inline-flex size-[15px] items-center justify-center rounded-pill text-subtle"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--border-default)" }}
          >
            <Icon name="chevronUpDown" size={9} strokeWidth={2.4} />
          </span>
        )}
      </span>
    );
    const markClass =
      "flex w-[76px] flex-col items-center rounded-md px-1 py-1 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]";
    // Single org → no menu/chevron, but still a link to the org home so the
    // user can reach the org's projects + members (ISS-470, AC7 — no dead-end).
    if (isSingle) {
      return (
        <Link href="/org" className={markClass} aria-label={`Organization: ${label}`} title={label}>
          {mark}
        </Link>
      );
    }
    return (
      <Menu
        side="bottom"
        align="left"
        items={items}
        triggerClassName="block"
        trigger={
          <button
            type="button"
            aria-haspopup="menu"
            aria-label={`Switch organization — current ${label}`}
            title={label}
            className={markClass}
          >
            {mark}
          </button>
        }
      />
    );
  }

  // Expanded variant (232px rail + mobile drawer): a labeled row mirroring the
  // project switcher button.
  const rowInner = (
    <>
      <span className="inline-flex size-[26px] flex-none items-center justify-center rounded-sm border border-line bg-surface text-subtle">
        <Icon name="users" size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="text-10 font-semibold uppercase tracking-[0.06em] text-subtle">Organization</span>
        <span className="fg-label whitespace-normal [overflow-wrap:anywhere]">{label}</span>
      </span>
      {!isSingle && <Icon name="chevronUpDown" size={15} className="flex-none text-subtle" />}
    </>
  );
  const rowClass = cn(
    "flex w-full items-center gap-2.5 rounded-md border border-line bg-sunken px-2.5 py-1.5 text-left",
  );
  if (isSingle) {
    return (
      <Link
        href="/org"
        className={cn(rowClass, "transition-colors hover:bg-hover")}
        aria-label={`Organization: ${label}`}
      >
        {rowInner}
      </Link>
    );
  }
  return (
    <Menu
      side="bottom"
      align="left"
      className="w-full"
      triggerClassName="block w-full"
      items={items}
      trigger={
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={`Switch organization — current ${label}`}
          className={cn(rowClass, "transition-colors hover:bg-hover")}
        >
          {rowInner}
        </button>
      }
    />
  );
}
