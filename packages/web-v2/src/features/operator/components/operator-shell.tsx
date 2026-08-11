"use client";

import { usePathname, useRouter } from "next/navigation";
import { NavRail, ScreenTabs, Skeleton, type NavItem } from "@/design";
import { useAuth } from "@/providers/auth-provider";
import { useOperatorWhoami } from "../hooks";
import { OPERATOR_SECTIONS, activeSectionFromPath, hrefForSection } from "../nav-model";
import type { OperatorSectionKey } from "../types";
import { OperatorTopbar } from "./operator-topbar";

const NAV_ITEMS: NavItem[] = OPERATOR_SECTIONS.map(({ key, label, icon }) => ({ key, label, icon }));
const TAB_ITEMS = OPERATOR_SECTIONS.map(({ key, label }) => ({ value: key, label }));

/** Layer-2 nav gate: the server already redirected non-admins before this
 *  ever mounts, so a failed/erroring whoami query keeps nav visible instead
 *  of blanking it — there's nothing to distrust yet. Nav hides only once the
 *  client confirms `isAdmin === false` (e.g. a session change post-render). */
export function OperatorShell({ email, children }: { email: string; children: React.ReactNode }) {
  const router = useRouter();
  const { logout } = useAuth();
  const pathname = usePathname() || "/admin";
  const active = activeSectionFromPath(pathname);
  const { data, isPending } = useOperatorWhoami();
  const showNav = data?.isAdmin !== false;

  function navigate(key: string) {
    router.push(hrefForSection(key as OperatorSectionKey));
  }

  const initials = email.slice(0, 2).toUpperCase() || "OP";

  return (
    <div className="flex h-dvh overflow-hidden bg-app">
      <div className="hidden h-full md:block">
        {isPending ? (
          <div className="flex h-full w-[232px] flex-col gap-2 border-r border-line bg-surface px-3 py-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          showNav && (
            <NavRail
              workspaceItems={NAV_ITEMS}
              activeKey={active}
              onNavigate={navigate}
              user={{ initials }}
              onAccount={() => router.push("/")}
              onSignOut={logout}
            />
          )
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <OperatorTopbar section={active} />

        <div className="md:hidden">
          {isPending ? (
            <div className="flex gap-2 border-b border-line px-4 py-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-20" />
              ))}
            </div>
          ) : (
            showNav && <ScreenTabs tabs={TAB_ITEMS} value={active} onChange={navigate} />
          )}
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
