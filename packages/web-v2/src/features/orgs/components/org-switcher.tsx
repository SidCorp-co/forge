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
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useActiveOrg } from "../active-org";
import type { OrgListItem } from "../types";

/** Personal orgs surface as "Personal" everywhere (matches Settings → Orgs and
 *  the legacy projects-toolbar label), in the interface language. */
function orgLabel(o: OrgListItem, personal: string): string {
  return o.isPersonal ? personal : o.name;
}

export function OrgSwitcher({ variant }: { variant: "compact" | "expanded" | "brand" }) {
  const router = useRouter();
  const { orgs, activeOrg, setActiveOrg, isSingle } = useActiveOrg();
  const t = useCopy();

  // Nothing to show until orgs resolve (avoids a flash of an empty control).
  if (!activeOrg) return null;

  const label = orgLabel(activeOrg, t("shell.org.personal"));

  const items: MenuItem[] = [
    ...orgs.map((o) => ({
      label: orgLabel(o, t("shell.org.personal")),
      icon: o.id === activeOrg.id ? ("check" as const) : undefined,
      onSelect: () => setActiveOrg(o.id),
    })),
    // Org home (ISS-470) — the active org's projects + members, one click away.
    { label: t("shell.org.home"), icon: "grid", onSelect: () => router.push("/org") },
    { label: t("shell.org.manage"), icon: "settings", onSelect: () => router.push("/settings?tab=orgs") },
  ];

  if (variant === "brand") {
    return (
      <Menu
        side="bottom"
        align="left"
        className="min-w-0 flex-1"
        triggerClassName="block w-full min-w-0"
        items={items}
        trigger={
          <button
            type="button"
            data-testid="brand-org-switcher"
            aria-haspopup="menu"
            aria-label={t("shell.org.named", { name: label })}
            className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-hover focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
          >
            <span className="fg-h3 min-w-0 flex-1 truncate" style={{ fontSize: "var(--text-16)" }}>
              {label}
            </span>
            <Icon name="chevronDown" size={14} className="flex-none text-subtle" />
          </button>
        }
      />
    );
  }

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
      <span title={label} className="mt-1 block min-w-0 max-w-full truncate text-center text-10 font-semibold tracking-[-0.01em] text-muted">
        {label}
      </span>
    );
    // Single org → no menu/chevron, but still a link to the org home so the
    // user can reach the org's projects + members (ISS-470, AC7 — no dead-end).
    if (isSingle) {
      return (
        <Link
          href="/org"
          className="flex w-[76px] flex-col items-center rounded-md px-1 pb-1 pt-5px transition-colors hover:bg-hover"
          aria-label={t("shell.org.named", { name: label })}
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
            aria-label={t("shell.org.switch", { name: label })}
            className="flex w-[76px] flex-col items-center rounded-md px-1 pb-1 pt-5px transition-colors hover:bg-hover"
          >
            {glyph}
            {labelEl}
          </button>
        }
      />
    );
  }

  // Expanded variant (248px rail + mobile drawer): a labeled row mirroring the
  // project switcher button.
  const rowInner = (
    <>
      <span className="inline-flex size-[26px] flex-none items-center justify-center rounded-sm border border-line bg-surface text-subtle">
        <Icon name="users" size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="text-10 font-semibold uppercase tracking-[0.06em] text-subtle">{t("shell.org.kicker")}</span>
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
        aria-label={t("shell.org.named", { name: label })}
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
          aria-label={t("shell.org.switch", { name: label })}
          className={cn(rowClass, "transition-colors hover:bg-hover")}
        >
          {rowInner}
        </button>
      }
    />
  );
}
