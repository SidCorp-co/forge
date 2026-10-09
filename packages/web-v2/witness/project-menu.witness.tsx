// The project menu witnessed as drawn (REQ-34 BC-23; ISS-457): Requirements, Workflows, Releases and
// Feedback sit under Product, open, and the build machinery under Delivery, with no Development left.
// At 1440 px the labelled rail and the compact rail are drawn side by side; at 390 px the phone's
// drawer, the only navigation there. Each probe reads the rows as laid out, never the menu's model.
//
//   pnpm --filter web-v2 witness witness/project-menu.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createRoot } from "react-dom/client";
import { NavRail } from "@/design";
import { MobileNavDrawer } from "@/features/shell/components/mobile-nav-drawer";
import { projectMenu, workspaceNavItems } from "@/features/shell/nav-model";
import "./entry";

const PRODUCT = ["Requirements", "Workflows", "Releases", "Feedback"];
const DELIVERY = ["Overview", "Issues", "Modules", "Agents / Runs", "Contracts", "Automation"];
const PHONE = 600;

window.localStorage.clear();
// the drawer's org and ecosystem reads stay in flight: the project tier is drawn from the menu alone
window.fetch = () => new Promise<Response>(() => {});

const noop = () => {};
// the drawer's org switcher reads the router; nothing here navigates
const router = { push: noop, replace: noop, prefetch: noop, back: noop, forward: noop, refresh: noop, hmrRefresh: noop };
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const phone = window.innerWidth < PHONE;
const rail = (compact: boolean) => (
  <div style={{ height: "100vh" }} data-testid={compact ? "witness-compact" : "witness-labelled"}>
    <NavRail compact={compact} workspaceItems={workspaceNavItems(0, undefined)} projectItems={projectMenu({})} activeKey="proj-requirements" onNavigate={noop} groupOpen={{}} onToggleGroup={noop} />
  </div>
);

createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={client}>
    <AppRouterContext.Provider value={router as never}>
    {phone ? (
      <MobileNavDrawer
        open
        onClose={noop}
        slug="hop"
        railSlug="hop"
        railProjectName="HOP"
        activeKey="proj-requirements"
        attentionCount={0}
        badges={{}}
        scopedProjects={[]}
        onNavigate={noop}
        onOpenProject={noop}
        onCreateProject={noop}
        onViewAllProjects={noop}
      />
    ) : (
      <div style={{ display: "flex", gap: 24 }}>
        {rail(false)}
        {rail(true)}
      </div>
    )}
    </AppRouterContext.Provider>
  </QueryClientProvider>,
);

const shown = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};
const texts = (root: Element, sel: string) => [...root.querySelectorAll(sel)].filter(shown).map((e) => (e.textContent ?? "").trim());

/** What is wrong with one drawn group: its head's words, whether it is open, and its rows in order. */
function group(root: ParentNode, key: string, head: string, rows: string[], open: boolean | null): string[] {
  const g = root.querySelector(`[data-testid=rail-group-${key}]`);
  if (!g) return [`no ${head} group is drawn`];
  const wrong: string[] = [];
  const button = g.querySelector("button");
  const label = button?.getAttribute("aria-label") ?? button?.textContent?.trim() ?? "";
  if (!label.startsWith(head)) wrong.push(`the ${key} group's head reads "${label}", not "${head}"`);
  if (open !== null && button?.getAttribute("aria-expanded") !== String(open)) wrong.push(`the ${head} group is ${open ? "closed" : "open"}`);
  if (open) {
    const drawn = [...g.querySelectorAll("button")].slice(1).filter(shown).map((b) => b.getAttribute("title") ?? b.textContent?.trim() ?? "");
    if (drawn.join("|") !== rows.join("|")) wrong.push(`the ${head} group draws ${drawn.join(", ") || "nothing"}, not ${rows.join(", ")}`);
  }
  return wrong;
}

function rails(): string[] {
  const wrong: string[] = [];
  for (const id of ["witness-labelled", "witness-compact"]) {
    const root = document.querySelector(`[data-testid=${id}]`);
    if (!root) {
      wrong.push(`the ${id} rail is not drawn`);
      continue;
    }
    wrong.push(...group(root, "product", "Product", PRODUCT, true).map((w) => `${id}: ${w}`));
    wrong.push(...group(root, "delivery", "Delivery", DELIVERY, false).map((w) => `${id}: ${w}`));
    for (const row of PRODUCT) {
      const outside = [...root.querySelectorAll("button")].filter((b) => !b.closest("[data-testid=rail-group-product]") && (b.getAttribute("title") ?? b.textContent ?? "").trim() === row);
      if (outside.length > 0) wrong.push(`${id}: ${row} is drawn outside Product`);
    }
    if ((root.textContent ?? "").includes("Development")) wrong.push(`${id}: the rail still reads Development`);
  }
  return wrong;
}

function drawer(): string[] {
  const wrong: string[] = [];
  const all = texts(document.body, "span, button");
  const at = (word: string) => all.indexOf(word);
  for (const head of ["Product", "Delivery"]) if (at(head) < 0) wrong.push(`the drawer draws no ${head} heading`);
  const product = all.slice(at("Product") + 1, at("Delivery"));
  for (const row of PRODUCT) if (!product.includes(row)) wrong.push(`the drawer draws ${row} outside Product`);
  if (all.includes("Development")) wrong.push("the drawer still reads Development");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => (phone ? document.body.textContent?.includes("Dashboard") === true : document.querySelectorAll("[data-testid^=witness-] nav").length === 2),
  probe: () => {
    const wrong = phone ? drawer() : rails();
    if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
    return wrong;
  },
};
