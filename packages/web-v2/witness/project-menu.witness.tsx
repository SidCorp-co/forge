// The project menu witnessed as drawn (REQ-34 BC-23; ISS-457): Requirements, Workflows, Releases and
// Feedback sit under Product, open, and the build machinery under Delivery, with no Development left;
// and no Questions or Lessons row anywhere (REQ-33 BC-8, BC-9).
// At 1440 px the labelled rail and the compact rail are drawn side by side; at 390 px the phone's
// drawer, the only navigation there. Each probe reads the rows as laid out, never the menu's model.
// A third rail, compact with Delivery open as well, reads the collapsed layout (ISS-1073 round 2): icons
// only, nothing past the rail's edge, no scrollbar of its own and no corner square.
//
//   pnpm --filter web-v2 witness witness/project-menu.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { NavRail } from "@/design";
import { MobileNavDrawer } from "@/features/shell/components/mobile-nav-drawer";
import { projectMenu, workspaceNavItems } from "@/features/shell/nav-model";
import "./entry";
import { InRouter } from "./router";

// in the order the menu draws them since Feedback led Product and Channels joined it (nav-model.ts:projectMenu)
const PRODUCT = ["Feedback", "Requirements", "Releases", "Workflows", "Channels"];
const DELIVERY = ["Overview", "Issues", "Modules", "Agents / Runs", "Contracts", "Automation"];
const PHONE = 600;
/** Rows no project menu draws: a question is read in Approvals and on its item, a lesson by no person. */
const GONE = ["Questions", "Lessons"];

window.localStorage.clear();
// the drawer's org and ecosystem reads stay in flight: the project tier is drawn from the menu alone
window.fetch = () => new Promise<Response>(() => {});

const noop = () => {};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const phone = window.innerWidth < PHONE;
const rail = (compact: boolean, id = compact ? "witness-compact" : "witness-labelled", groupOpen: Record<string, boolean> = {}) => (
  <div style={{ height: "100vh" }} data-testid={id}>
    <NavRail compact={compact} workspaceItems={workspaceNavItems(0, undefined)} projectItems={projectMenu({})} activeKey="proj-requirements" onNavigate={noop} groupOpen={groupOpen} onToggleGroup={noop} />
  </div>
);

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter>
    <QueryClientProvider client={client}>
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
          {rail(true, "witness-compact-open", { delivery: true })}
        </div>
      )}
    </QueryClientProvider>
  </InRouter>,
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
    for (const row of GONE) if (texts(root, "button, span").some((t) => t === row) || root.querySelector(`button[title="${row}"]`)) wrong.push(`${id}: the rail still draws ${row}`);
  }
  return wrong;
}

/** The collapsed rails: no row's words drawn, nothing past the rail's edge, no scrollbar of their own. */
function collapsed(): string[] {
  const wrong: string[] = [];
  for (const id of ["witness-compact", "witness-compact-open"]) {
    const nav = document.querySelector<HTMLElement>(`[data-testid=${id}] nav`);
    const tiers = nav?.querySelector<HTMLElement>("[data-testid=rail-tiers]");
    if (!nav || !tiers) {
      wrong.push(`${id}: no rail drawn`);
      continue;
    }
    if (tiers.scrollWidth > tiers.clientWidth) wrong.push(`${id}: the rail scrolls sideways, ${tiers.scrollWidth} px in ${tiers.clientWidth}`);
    if (tiers.offsetWidth - tiers.clientWidth > 0 || tiers.offsetHeight - tiers.clientHeight > 0) wrong.push(`${id}: the rail draws a scrollbar of its own`);
    const edge = nav.getBoundingClientRect();
    for (const b of tiers.querySelectorAll<HTMLElement>("button")) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && (r.left < edge.left - 0.5 || r.right > edge.right + 0.5)) wrong.push(`${id}: ${b.getAttribute("title") ?? "a row"} runs past the rail, ${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(edge.left)}–${Math.round(edge.right)}`);
      const words = [...b.querySelectorAll<HTMLElement>("span")].filter((x) => shown(x) && x.getAttribute("aria-hidden") !== "true" && !/^\d+$/.test((x.textContent ?? "").trim()) && (x.textContent ?? "").trim() !== "" && x.children.length === 0);
      if (words.length > 0) wrong.push(`${id}: ${b.getAttribute("title") ?? "a row"} draws its words "${words.map((x) => x.textContent).join(" ")}"`);
    }
  }
  return wrong.slice(0, 12);
}

function drawer(): string[] {
  const wrong: string[] = [];
  const all = texts(document.body, "span, button");
  const at = (word: string) => all.indexOf(word);
  for (const head of ["Product", "Delivery"]) if (at(head) < 0) wrong.push(`the drawer draws no ${head} heading`);
  const product = all.slice(at("Product") + 1, at("Delivery"));
  for (const row of PRODUCT) if (!product.includes(row)) wrong.push(`the drawer draws ${row} outside Product`);
  if (all.includes("Development")) wrong.push("the drawer still reads Development");
  for (const row of GONE) if (all.includes(row)) wrong.push(`the drawer still draws ${row}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => (phone ? document.body.textContent?.includes("Dashboard") === true : document.querySelectorAll("[data-testid^=witness-] nav").length === 3),
  stages: (["light", "dark"] as const).map((theme) => ({
    name: theme,
    run: () => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle("dark", theme === "dark");
      const wrong = phone ? drawer() : [...rails(), ...collapsed()];
      if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
      return wrong;
    },
  })),
};
