// The page beside the Ask Agent panel (REQ-31 BC-3, BC-4; ISS-494), witnessed on the four busiest
// pages — issue detail, a requirement, the issues board and a run — at a phone, laptops and wide
// windows, with the panel at Large and at Half. Every stage reads the layout as drawn, never the code
// under witness:
// - beside: where the window holds the page's 480px minimum beside the panel at the width it is
//   drawn, the panel sits beside the page, the page keeps the rest, nothing in the page scrolls
//   sideways and nothing is drawn past its edges;
// - over: where it does not, the panel is drawn over the page, the page keeps the whole width it had
//   without the panel, and the panel carries a way back to the page.
// On a phone the panel is the full-screen slide-over, which is the over case at every size.
//
//   pnpm --filter web-v2 witness witness/page-beside-dock.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, PathParamsContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { Component, type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type ChatDockApi, DOCK_OPEN_ON_KEY, useChatDockState } from "@/features/chat-dock/dock";
import { DOCK_SIZE_KEY, PAGE_MIN_WIDTH } from "@/features/chat-dock/dock-size";
import { ChatDock } from "@/features/conversations/components/chat-dock";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { TopBarSlotProvider } from "@/design";
import type { ChromeScreen } from "@/test/vi-chrome-screens";
import { SCREENS as AGENT_SCREENS } from "@/test/vi-chrome-agents";
import { SCREENS as ISSUE_SCREENS } from "@/test/vi-chrome-issues";
import { SCREENS as REQUIREMENT_SCREENS } from "@/test/vi-chrome-requirements";
import "./entry";

const SIDEBAR = 280;
const PANEL_FLOOR = 360;

// the fixtures' own pages set the query string with replaceState, which a file:// page refuses for a path
const replace = window.history.replaceState.bind(window.history);
window.history.replaceState = (data, unused, url) => {
  try {
    replace(data, unused, url);
  } catch {
    /* the page stays at its file:// address; the fixtures read nothing from it */
  }
};

window.localStorage.clear();
// the shell reads no route (it sits outside the router contexts below), so the panel is left open on ""
window.localStorage.setItem(DOCK_OPEN_ON_KEY, JSON.stringify(""));
// a read no fixture seeded stays in flight, as in the vi walking test; the panel's project list is empty
window.fetch = (input: RequestInfo | URL) =>
  /\/projects(\?|$)/.test(String(input))
    ? Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }))
    : new Promise<Response>(() => {});

const named = (screens: ChromeScreen[], prefix: string): ChromeScreen => {
  const hit = screens.find((s) => s.name.startsWith(prefix));
  if (!hit) throw new Error(`no fixture screen is named "${prefix}…"`);
  return hit;
};

const PAGES = [
  { name: "issue", path: "/projects/hop/issues/ISS-1", screen: named(ISSUE_SCREENS, "Issue detail") },
  { name: "requirement", path: "/projects/hop/requirements/REQ-1", screen: named(REQUIREMENT_SCREENS, "Requirement detail · Overview") },
  { name: "board", path: "/projects/hop/issues", screen: named(ISSUE_SCREENS, "Issues board · attention") },
  { name: "run", path: "/projects/hop/agents/runs/run-5", screen: named(AGENT_SCREENS, "Run page · attempts") },
] as const;

const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {}, hmrRefresh() {} };

const at: { page: number; dock: ChatDockApi | null; show: (i: number) => void } = { page: 0, dock: null, show: () => {} };

function Shell() {
  const [page, setPage] = useState(0);
  const dock = useChatDockState(null);
  const column = useRef<HTMLDivElement>(null);
  useEffect(() => {
    at.dock = dock;
    at.page = page;
    at.show = setPage;
  });
  const p = PAGES[page] ?? PAGES[0];
  return (
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={p.path}>
        <PathParamsContext.Provider value={{ slug: "hop" }}>
          <SearchParamsContext.Provider value={new URLSearchParams() as never}>
            <TopBarSlotProvider>
              {/* as app/(workspace)/layout.tsx draws it: data-shell and data-page are what globals.css reads */}
              <div className="flex h-dvh overflow-hidden bg-app" data-shell>
                <div className="hidden h-full flex-none border-r border-line bg-surface md:block" style={{ width: SIDEBAR }} data-witness="sidebar" />
                <div ref={column} className="flex min-w-0 flex-1 flex-col" data-witness="page" data-witness-page={p.name} data-page>
                  <ShellTopBar chatOpen={dock.open} onToggleChat={dock.toggle} />
                  <main className="min-h-0 flex-1 overflow-y-auto pb-[calc(56px+env(safe-area-inset-bottom))] window-md:pb-0" data-witness="main">
                    <Page key={p.name} screen={p.screen} />
                  </main>
                </div>
                <ChatDock dock={dock} page={column} />
              </div>
            </TopBarSlotProvider>
          </SearchParamsContext.Provider>
        </PathParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

function Page({ screen }: { screen: ChromeScreen }): ReactElement {
  return <Caught>{screen.render()}</Caught>;
}

/** A page that throws is named by the stage that drew it, never read as a page that drew nothing. */
class Caught extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.message} ${e.stack?.split("\n").slice(1, 4).join(" ") ?? ""}` : String(e) };
  }
  render() {
    return this.state.error ? <p data-witness="threw">{this.state.error}</p> : this.props.children;
  }
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const rect = (el: HTMLElement | null) => el?.getBoundingClientRect() ?? new DOMRect();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docked = () => window.innerWidth >= 768;
const label = (el: Element) => {
  const id = el.getAttribute("data-testid");
  const cls = String(el.getAttribute("class") ?? "").split(" ").filter(Boolean).slice(0, 3).join(".");
  return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ""}${cls ? `.${cls}` : ""}`;
};

/** Out of the layout, folded away (a closed <details>), hidden, or drawn too small to read: nothing a person sees. */
function unseen(el: HTMLElement, r: DOMRect): boolean {
  if (r.width <= 1 || r.height <= 1) return true;
  if (!el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) return true;
  const s = getComputedStyle(el);
  return s.visibility === "hidden" || s.position === "fixed" || el.closest("[aria-hidden='true'],[hidden],.sr-only") !== null;
}

/** Words a column too narrow for them broke across lines ("Q / ue / ue / d"): a page squeezed, not reflowed. */
function brokenWords(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || unseen(el, el.getBoundingClientRect())) continue;
    for (const m of (n.textContent ?? "").matchAll(/[\p{L}\p{N}]{2,24}/gu)) {
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
      if (lines.size > 1) {
        out.push(`"${m[0]}" in ${label(el)} (${Math.round(el.getBoundingClientRect().width)} px)`);
        break;
      }
    }
  }
  return out;
}

/** Controls drawn on top of one another (a title under the top bar's actions): neither inside the other, their boxes cross. */
function overlapping(root: HTMLElement): string[] {
  const controls = [...root.querySelectorAll<HTMLElement>("a, button, [role=tab], h1, h2")].filter((el) => !unseen(el, el.getBoundingClientRect()));
  const out: string[] = [];
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const [a, b] = [controls[i] as HTMLElement, controls[j] as HTMLElement];
      if (a.contains(b) || b.contains(a)) continue;
      const [r, u] = [a.getBoundingClientRect(), b.getBoundingClientRect()];
      const w = Math.min(r.right, u.right) - Math.max(r.left, u.left);
      const h = Math.min(r.bottom, u.bottom) - Math.max(r.top, u.top);
      if (w > 2 && h > 2) out.push(`${label(a)} "${a.innerText.trim().slice(0, 30)}" and ${label(b)} "${b.innerText.trim().slice(0, 30)}" are drawn over each other`);
    }
  }
  return out;
}

/** The page column as it stands beside the panel: its width, what scrolls sideways in it, what is drawn past its edges, what it squeezed. */
function besideWrongs(room: number, panelWidth: number): string[] {
  const wrong: string[] = [];
  const column = q("[data-witness=page]");
  const main = q("[data-witness=main]");
  if (!column || !main) return ["the page column is not drawn"];
  const col = rect(column);
  if (Math.round(col.width) !== room - panelWidth) wrong.push(`the page is ${Math.round(col.width)} px beside a ${panelWidth} px panel in ${room} px; it should keep ${room - panelWidth}`);
  if (Math.round(col.width) < PAGE_MIN_WIDTH) wrong.push(`the page is ${Math.round(col.width)} px beside the panel, under its ${PAGE_MIN_WIDTH} px minimum`);
  const scrollers: string[] = [];
  const cut: string[] = [];
  // the whole page column: the top bar the page puts its title and actions in, and the page under it
  for (const el of [main, ...column.querySelectorAll<HTMLElement>("*")]) {
    const r = el.getBoundingClientRect();
    if (unseen(el, r)) continue;
    const x = getComputedStyle(el).overflowX;
    if ((x === "auto" || x === "scroll") && el.scrollWidth > el.clientWidth + 1) scrollers.push(`${label(el)} scrolls sideways: ${el.scrollWidth} px in ${el.clientWidth}`);
    if (el !== main && (r.right > col.right + 1 || r.left < col.left - 1)) cut.push(`${label(el)} is drawn at ${Math.round(r.left)}–${Math.round(r.right)}, past the page's ${Math.round(col.left)}–${Math.round(col.right)}`);
  }
  if (scrollers.length) wrong.push(`${scrollers.length} thing(s) scroll sideways; first: ${scrollers.slice(0, 3).join("; ")}`);
  if (cut.length) wrong.push(`${cut.length} thing(s) are cut off at the page's edge; first: ${cut.slice(0, 3).join("; ")}`);
  const crossed = overlapping(column);
  if (crossed.length) wrong.push(`${crossed.length} pair(s) of controls overlap; first: ${crossed.slice(0, 3).join("; ")}`);
  const broken = brokenWords(column);
  if (broken.length) wrong.push(`${broken.length} word(s) are broken across lines by a squeezed column; first: ${broken.slice(0, 3).join("; ")}`);
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the window scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

/** The panel's way back to the page, read as a person reads it. */
function wayBack(within: HTMLElement | null): string[] {
  const back = [...(within?.querySelectorAll<HTMLElement>("button") ?? [])].find((b) => /^←?\s*Back to /.test(b.innerText.trim()));
  if (!back) return ["the panel over the page says no way back to it (no \"Back to …\" button)"];
  const r = back.getBoundingClientRect();
  return r.width < 1 || r.top < 0 || r.bottom > window.innerHeight ? [`the way back is not on screen (${Math.round(r.top)}–${Math.round(r.bottom)})`] : [];
}

/** Over the page: the panel is drawn on top of it, the page keeps the whole room, and the panel says how to return. */
function overWrongs(room: number): string[] {
  const panel = q("[data-testid=chat-dock]");
  const wrong: string[] = [];
  if (!panel) return ["the panel is not drawn"];
  const col = rect(q("[data-witness=page]"));
  if (Math.round(col.width) !== room) wrong.push(`the page is ${Math.round(col.width)} px with the panel over it; it should keep the whole ${room} px`);
  const p = rect(panel);
  if (Math.round(p.right) !== window.innerWidth) wrong.push(`the panel over the page ends at ${Math.round(p.right)}, not the window's right edge`);
  const top = document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2);
  if (!top || !panel.contains(top)) wrong.push("the panel is not on top of the page where it is drawn");
  return [...wrong, ...wayBack(panel)];
}

/** One page at one size: the page and the panel as the window lays them out. */
function laidOut(): string[] {
  if (!docked()) {
    const body = q("[data-testid=chat-dock-body]");
    if (!body) return ["the panel did not open"];
    const wrong = q("[data-testid=chat-dock]") ? ["the panel is docked beside the page on a phone"] : [];
    return [...wrong, ...wayBack(body)];
  }
  const panel = q("[data-testid=chat-dock]");
  if (!panel) return ["the panel is not drawn"];
  const room = window.innerWidth - Math.round(rect(q("[data-witness=page]")).left);
  const width = Math.round(rect(panel).width);
  const over = room - width < PAGE_MIN_WIDTH;
  const wrong = over ? overWrongs(room) : besideWrongs(room, width);
  return wrong.map((w) => `${w} (window ${window.innerWidth}, room ${room}, panel ${width}: ${over ? "over" : "beside"})`);
}

async function settle(page: number, size: "large" | "half") {
  at.show(page);
  await pause(50);
  at.dock?.setSize(size);
  // the screens draw their seeded reads on the next frames; a run page's tab and a board's columns settle last
  await pause(400);
}

const sizes = ["large", "half"] as const;
const stages = PAGES.flatMap((p, i) =>
  (docked() ? sizes : (["large"] as const)).map((size) => ({
    name: `${p.name}-${size}`,
    run: async () => {
      await settle(i, size);
      if (!q(`[data-witness=page][data-witness-page=${p.name}]`)) return [`the ${p.name} page is not the one drawn`];
      const threw = q("[data-witness=threw]");
      if (threw) return [`the ${p.name} page threw: ${threw.innerText.slice(0, 300)}`];
      if (docked()) {
        const room = window.innerWidth - Math.round(rect(q("[data-witness=page]")).left);
        const large = Math.max(PANEL_FLOOR, room - PAGE_MIN_WIDTH);
        const want = size === "large" ? large : Math.round(large / 2);
        const drawn = Math.round(rect(q("[data-testid=chat-dock]")).width);
        if (drawn !== want) return [`the panel is ${drawn} px at ${size}, not ${want}`, ...laidOut()];
      }
      return laidOut();
    },
  })),
);

window.__witness = {
  cases: [
    { name: "phone-390", width: 390 },
    { name: "laptop-900", width: 900 },
    { name: "laptop-1024", width: 1024 },
    { name: "laptop-1280", width: 1280 },
    { name: "wide-1440", width: 1440 },
    { name: "wide-2560", width: 2560 },
  ],
  ready: () => Boolean(q("[data-testid=chat-dock-body]")) && window.localStorage.getItem(DOCK_SIZE_KEY) !== null,
  stages,
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(root).render(
  <QueryClientProvider client={queries}>
    <Shell />
  </QueryClientProvider>,
);
