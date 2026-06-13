"use client";

// Global org switcher (ISS-469) — the always-visible "current org" control in
// the app chrome. Reads the active-org context and renders:
//   • the active org name (AC1),
//   • a dropdown of all orgs, personal-first then alpha, selectable (AC2),
//   • a "Manage organizations" entry → Settings → Orgs (AC6, reuses ISS-468),
//   • a static, non-interactive label when the user has a single org (AC5).
// Two variants match the two rail widths; `expanded` is also used in the mobile
// drawer. Presentational beyond the context read — no data fetching of its own.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/design/icons/icon";
import { Menu, type MenuItem } from "@/design/patterns/menu";
import { cn } from "@/lib/utils/cn";
import { useActiveOrg } from "../active-org";
import type { OrgListItem } from "../types";

/** Personal orgs surface as "Personal" everywhere (matches Settings → Orgs and
 *  the legacy projects-toolbar label). */
function orgLabel(o: OrgListItem): string {
  return o.isPersonal ? "Personal" : o.name;
}

export function OrgSwitcher({ variant }: { variant: "compact" | "expanded" }) {
  const router = useRouter();
  const { orgs, activeOrg, setActiveOrg, isSingle } = useActiveOrg();

  // Nothing to show until orgs resolve (avoids a flash of an empty control).
  if (!activeOrg) return null;

  const label = orgLabel(activeOrg);

  const items: MenuItem[] = [
    ...orgs.map((o) => ({
      label: orgLabel(o),
      icon: o.id === activeOrg.id ? ("check" as const) : undefined,
      onSelect: () => setActiveOrg(o.id),
    })),
    // Org home (ISS-470) — the active org's projects + members, one click away.
    { label: "Organization home", icon: "grid", onSelect: () => router.push("/org") },
    { label: "Manage organizations", icon: "settings", onSelect: () => router.push("/settings?tab=orgs") },
  ];

  if (variant === "compact") {
    const glyph = (
      <span className="relative inline-flex">
        <span
          className="inline-flex size-[30px] items-center justify-center rounded-md border border-line bg-sunken text-subtle"
        >
          <Icon name="users" size={16} />
        </span>
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
    const labelEl = (
      <span className="mt-1 block max-w-[64px] truncate text-center text-[9.5px] font-semibold tracking-[-0.01em] text-muted">
        {label}
      </span>
    );
    // Single org → no menu/chevron, but still a link to the org home so the
    // user can reach the org's projects + members (ISS-470, AC7 — no dead-end).
    if (isSingle) {
      return (
        <Link
          href="/org"
          className="flex w-[60px] flex-col items-center rounded-md pb-1 pt-[5px] transition-colors hover:bg-hover"
          aria-label={`Organization: ${label}`}
        >
          {glyph}
          {labelEl}
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
            className="flex w-[60px] flex-col items-center rounded-md pb-1 pt-[5px] transition-colors hover:bg-hover"
          >
            {glyph}
            {labelEl}
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
        <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-subtle">Organization</span>
        <span className="fg-label truncate">{label}</span>
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
