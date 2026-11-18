// The workspace rail beside the Activity page (ISS-1330, ISS-1331), at 1440×900 labelled and compact,
// light and dark, and at 390 with More open. The rail is the shell's own WorkspaceSidebar over the
// sidebar's own persisted choice; the page is the Activity screen over the same stubbed core read.
// Each stage reads that one group per tier is open, that the Workspace items stand inside the window,
// that the foot is one row no taller than 56 px, and that the Activity badge equals the page's You
// column; the menu stage reads What's new, Help, the guides and the version in the chip's menu. Each
// stage prints `WORDS rail <stage> <n>`, the words the rail draws.
//
//   pnpm --filter web-v2 witness witness/rail-accordion.witness.tsx --out <dir>

import type { OrgActivity } from "@forge/contracts/org-activity";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BottomTabBar, TopBarSlotProvider } from "@/design";
import { WORKSPACE_MAIN, WORKSPACE_PAGE_COLUMN } from "@/design/templates/workspace-frame";
import { ActivityScreen, useActivityWaiting } from "@/features/activity";
import { ActiveOrgProvider } from "@/features/orgs";
import { MobileNavDrawer, SidebarProvider, bottomTabItems, useSidebarContext } from "@/features/shell";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { SidebarBell } from "@/features/shell/components/sidebar-bell";
import { SidebarSearch } from "@/features/shell/components/sidebar-search";
import { WorkspaceSidebar } from "@/features/shell/components/workspace-sidebar";
import { FORGE, ORG, QUIET, person, project, read } from "../src/test/activity.fixture";
import "./entry";
import { firstScreenWords } from "./first-screen";
import { InRouter } from "./router";

const AHFE = project({
  projectId: "p-ahfe",
  slug: "ahfe-slug",
  name: "AdminHub FE",
  standing: "idle",
  people: { total: 1, items: [person({ decisionId: "answer:ISS-88", key: "ISS-88", title: "Bulk edit: keep or drop the old modal" })] },
});
const READ: OrgActivity = read([{ ...FORGE, people: { total: 3, items: FORGE.people.items } }, AHFE, QUIET]);

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if (path === `/orgs/${ORG}/activity`) return json(READ);
  if (path === "/orgs") return json([{ id: ORG, slug: "sidcorp", name: "SidCorp", isPersonal: false, role: "owner" }]);
  if (path === "/auth/me/preferences") return json({ activeOrgId: ORG });
  if (path === "/version") return json({ version: "0.4.0-dev.737", sourceCommit: null });
  if (path === "/me/whats-new/summary") return json({ environment: "dev", release: null });
  if (path === "/projects/health") return json([]);
  if (path === "/projects") return json([]);
  return new Promise<Response>(() => {});
};
try {
  localStorage.removeItem("web-v2:sidebar");
} catch {
  // a page with no storage keeps the sidebar's choice in memory
}

const glyph = { tint: "var(--cobalt-50)", ink: "var(--cobalt-700)" };
const RAIL = {
  projectMark: { name: "Forge", initials: "FO", ...glyph, liveRuns: 2 },
  switcherProjects: [{ id: "p-forge", slug: "forge", name: "Forge", initials: "FO", ...glyph, liveRuns: 2, pinned: true }],
  togglePin: () => {},
};
const noop = () => {};

const at: { page: (key: string) => void; more: (open: boolean) => void; collapse: (c: boolean) => void; choose: (c: Record<string, boolean>) => void } = {
  page: noop,
  more: noop,
  collapse: noop,
  choose: noop,
};

function Frame() {
  const sidebar = useSidebarContext();
  const [activeKey, setActiveKey] = useState("activity");
  const [moreOpen, setMoreOpen] = useState(false);
  const waiting = useActivityWaiting();
  useEffect(() => {
    at.page = setActiveKey;
    at.more = setMoreOpen;
    at.collapse = (c) => {
      if (c !== sidebar.collapsed) sidebar.toggleCollapsed();
    };
    at.choose = sidebar.chooseGroups;
  });
  return (
    <div className="flex h-dvh overflow-hidden bg-shell" data-shell>
      <div className="hidden h-full md:block" data-testid="desktop-sidebar">
        <WorkspaceSidebar
          collapsed={sidebar.collapsed}
          onToggleCollapsed={sidebar.toggleCollapsed}
          groupOpen={sidebar.groupOpen}
          onChooseGroups={sidebar.chooseGroups}
          activeKey={activeKey}
          attentionCount={4}
          railSlug="forge"
          rail={RAIL}
          badges={{}}
          onNavigate={setActiveKey}
          onRoute={noop}
          onSignOut={noop}
          userInitials="OR"
          search={(variant) => <SidebarSearch onOpen={noop} compact={variant === "compact"} icon={variant === "icon"} />}
          bell={<SidebarBell count={2} onToggle={noop} />}
        />
      </div>
      <MobileNavDrawer
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        slug={null}
        railSlug="forge"
        railProjectName="Forge"
        activeKey={activeKey}
        attentionCount={4}
        badges={{}}
        scopedProjects={[]}
        onNavigate={setActiveKey}
        onOpenProject={noop}
        onCreateProject={noop}
        onViewAllProjects={noop}
      />
      <div className={WORKSPACE_PAGE_COLUMN} data-witness="page">
        <ShellTopBar chatOpen={false} onToggleChat={noop} />
        <main className={WORKSPACE_MAIN}>
          <ActivityScreen />
        </main>
      </div>
      <BottomTabBar items={bottomTabItems(4, waiting)} activeKey={moreOpen ? "more" : "home"} onSelect={(k) => k === "more" && setMoreOpen(true)} />
    </div>
  );
}

const q = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
/** A press as a pointer makes it: the menu opens on the pointer, a plain click() reaches no menu. */
const press = (el: HTMLElement) => {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  el.click();
};
const head = (key: string) => q(`[data-testid=rail-group-${key}] button`);
const expanded = (key: string) => head(key)?.getAttribute("aria-expanded") === "true";
const pageTotal = () => [...document.querySelectorAll("[data-testid=activity-you]")].reduce((n, b) => n + Number(b.textContent), 0);

/** What every desktop stage holds: one group per tier, the Workspace items in the window, a one-row foot, the badge the page's. */
function railHolds(): string[] {
  const wrong: string[] = [];
  const nav = q("[data-testid=desktop-sidebar] nav");
  if (!nav) return ["no rail drawn"];
  const open = ["product", "delivery"].filter(expanded);
  if (open.length > 1) wrong.push(`${open.join(" and ")} are open together`);
  const workspace = q("[role=group][aria-label=Workspace]", nav);
  for (const b of workspace?.querySelectorAll<HTMLElement>("button") ?? []) {
    const r = b.getBoundingClientRect();
    const tiers = q("[data-testid=rail-tiers]", nav)?.getBoundingClientRect();
    if (!tiers || r.bottom > tiers.bottom + 1 || r.bottom > window.innerHeight) wrong.push(`${b.getAttribute("aria-label") ?? b.textContent} is below the fold (${Math.round(r.bottom)} px)`);
  }
  const foot = q("[data-testid=rail-footer]", nav)?.getBoundingClientRect();
  if (!foot) wrong.push("no foot drawn");
  else if (foot.height > 56) wrong.push(`the foot is ${Math.round(foot.height)} px tall`);
  const activity = [...(workspace?.querySelectorAll<HTMLElement>("button") ?? [])].find((b) => /^Activity/.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
  if (!activity) wrong.push("no Activity row named Activity");
  const badge = activity?.textContent?.replace(/\D/g, "") ?? "";
  if (badge !== String(pageTotal())) wrong.push(`the Activity badge reads "${badge}", the page's You column ${pageTotal()}`);
  const words = firstScreenWords(nav as HTMLElement, { whole: true });
  const last = workspace?.lastElementChild?.getBoundingClientRect();
  console.log(`WORDS rail ${words.count} :: ${words.words.join(" ")} | foot ${Math.round(foot?.height ?? 0)}px | workspace ends ${Math.round(last?.bottom ?? 0)}px | badge ${badge} title "${activity?.getAttribute("title") ?? ""}" | page ${pageTotal()}`);
  return wrong;
}

const desktop = (compact: boolean, t: "light" | "dark") => {
  const w = compact ? "compact" : "labelled";
  const settle = async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    at.collapse(compact);
    theme(t);
    await pause(400);
  };
  return [
    {
      name: `${w}-product-open-${t}`,
      run: async () => {
        await settle();
        at.page("activity");
        at.choose({ product: true, delivery: false });
        await pause(400);
        return [...(expanded("product") ? [] : ["Product is not open"]), ...railHolds()];
      },
    },
    {
      name: `${w}-delivery-open-${t}`,
      run: async () => {
        const h = head("delivery");
        if (!h) return ["no Delivery head"];
        press(h);
        await pause(400);
        return [...(expanded("delivery") && !expanded("product") ? [] : ["opening Delivery left Product open, or did not open"]), ...railHolds()];
      },
    },
    {
      name: `${w}-issues-delivery-closed-${t}`,
      run: async () => {
        at.page("proj-issues");
        await pause(300);
        if (!expanded("delivery")) return ["arriving on Issues did not open Delivery"];
        const h = head("delivery");
        if (h) press(h);
        await pause(400);
        return [...(expanded("delivery") ? ["Delivery could not be closed on an Issues page"] : []), ...railHolds()];
      },
    },
    {
      name: `${w}-menu-${t}`,
      run: async () => {
        const chip = q("[data-testid=rail-footer] [aria-haspopup=menu]");
        if (!chip) return ["no account chip"];
        press(chip);
        await pause(500);
        const menu = q("[role=menu]");
        if (!menu) return ["the chip opened no menu"];
        const rows = [...menu.querySelectorAll("[role=menuitem]")].map((i) => i.textContent?.trim());
        const last = menu.lastElementChild?.textContent?.trim();
        console.log(`MENU ${rows.join(" | ")} || ${last}`);
        const wrong = ["What's new", "Help", "Docs"].filter((r) => !rows.includes(r)).map((r) => `the menu holds no ${r}`);
        if (last !== "Forge v0.4.0-dev.737") wrong.push(`the menu ends on "${last}", not the version`);
        return wrong;
      },
    },
  ];
};

const moreTab = (t: "light" | "dark") => ({
  name: `more-tab-${t}`,
  run: async () => {
    theme(t);
    at.more(false);
    await pause(500);
    const more = q("button[aria-label^=More]");
    const n = String(pageTotal());
    console.log(`PHONE tab more "${more?.getAttribute("aria-label")}" page ${n}`);
    return more?.textContent?.includes(n) ? [] : [`the More tab reads "${more?.textContent}", the page ${n}`];
  },
});

const moreOpen = (t: "light" | "dark") => ({
  name: `more-open-${t}`,
  run: async () => {
    theme(t);
    at.more(true);
    await pause(700);
    const row = [...document.querySelectorAll<HTMLElement>("[role=dialog] button")].find((b) => b.textContent?.startsWith("Activity"));
    row?.scrollIntoView({ block: "center" });
    await pause(300);
    const n = String(pageTotal());
    console.log(`PHONE row "${row?.textContent}" page ${n}`);
    return row?.textContent?.replace(/\D/g, "") === n ? [] : [`More's Activity row reads "${row?.textContent}", the page ${n}`];
  },
});

const wide = window.innerWidth >= 768;
window.__witness = {
  cases: [
    { name: "wide-1440", width: 1440, height: 900 },
    { name: "phone-390", width: 390, height: 844 },
  ],
  ready: () => pageTotal() > 0,
  stages: wide ? [...desktop(false, "light"), ...desktop(false, "dark"), ...desktop(true, "light"), ...desktop(true, "dark")] : [moreTab("light"), moreOpen("light"), moreTab("dark"), moreOpen("dark")],
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <InRouter at="/activity" pattern="/activity">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })}>
      <ActiveOrgProvider>
        <TopBarSlotProvider>
          <SidebarProvider>
            <Frame />
          </SidebarProvider>
        </TopBarSlotProvider>
      </ActiveOrgProvider>
    </QueryClientProvider>
  </InRouter>,
);
