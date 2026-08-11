"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { NavRail, ScreenTabs, type NavItem } from "@/design";
import { useAuth } from "@/providers/auth-provider";
import { useOperatorWhoami } from "../hooks";
import { OPERATOR_SECTIONS, activeSectionFromPath, hrefForSection } from "../nav-model";
import type { OperatorSectionKey, OperatorWhoami } from "../types";
import { OperatorTopbar } from "./operator-topbar";

const NAV_ITEMS: NavItem[] = OPERATOR_SECTIONS.map(({ key, label, icon }) => ({ key, label, icon }));
const TAB_ITEMS = OPERATOR_SECTIONS.map(({ key, label }) => ({ value: key, label }));

/** Layer-2 nav gate: the middleware already refused non-admins before this
 *  render, and the query is seeded from that same server verdict, so an
 *  erroring refetch keeps nav visible instead of blanking it. Only an explicit
 *  `isAdmin === false` — a session that lost admin mid-visit — hides nav. */
export function OperatorShell({
  initialWhoami,
  children,
}: {
  initialWhoami: OperatorWhoami;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { logout } = useAuth();
  const pathname = usePathname() || "/admin";
  const active = activeSectionFromPath(pathname);
  const { data } = useOperatorWhoami(initialWhoami);
  const lostAdmin = data?.isAdmin === false;

  // cm:why refresh re-runs the middleware gate, which 307s a demoted session out of /admin — otherwise it sits on a navless console with no way back
  useEffect(() => {
    if (lostAdmin) router.refresh();
  }, [lostAdmin, router]);

  function navigate(key: string) {
    router.push(hrefForSection(key as OperatorSectionKey));
  }

  const account = { onAccount: () => router.push("/settings"), onSignOut: logout };
  const initials = initialWhoami.email.slice(0, 2).toUpperCase() || "OP";

  return (
    <div className="flex h-dvh overflow-hidden bg-app">
      {!lostAdmin && (
        <div className="hidden h-full md:block">
          <NavRail
            workspaceItems={NAV_ITEMS}
            activeKey={active}
            onNavigate={navigate}
            user={{ initials }}
            {...account}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <OperatorTopbar section={active} {...account} />

        {!lostAdmin && (
          <div className="md:hidden [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]">
            <ScreenTabs tabs={TAB_ITEMS} value={active} onChange={navigate} />
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
