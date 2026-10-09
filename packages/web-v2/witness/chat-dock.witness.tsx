// The Ask Agent panel beside the page, witnessed at a phone, a laptop and wide windows (REQ-31 r2;
// ISS-493): a first open takes the large width, which leaves the page exactly its 480px minimum; the
// size control switches it to half and back; a drag sets a width between, stops at either size, and
// the control snaps it back. The browser arrives with a width saved by the old build, which the
// first open moves to large. On a phone the panel is the full-screen slide-over with no size control.
//
//   pnpm --filter web-v2 witness witness/chat-dock.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { DOCK_OPEN_ON_KEY, useChatDockState } from "@/features/chat-dock/dock";
import { DOCK_SIZE_KEY, LEGACY_DOCK_WIDTH_KEY, PAGE_MIN_WIDTH } from "@/features/chat-dock/dock-size";
import { ChatDock } from "@/features/conversations/components/chat-dock";
import "./entry";

const SIDEBAR = 280;
const PANEL_FLOOR = 360;

// every case is a browser's first open after this change: it kept a 650px width under the old key,
// and the panel was left open on this page
window.localStorage.clear();
window.localStorage.setItem(LEGACY_DOCK_WIDTH_KEY, "650");
window.localStorage.setItem(DOCK_OPEN_ON_KEY, JSON.stringify(""));

window.fetch = async (input: RequestInfo | URL) =>
  String(input).includes("/projects")
    ? new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });

function Shell() {
  const dock = useChatDockState(null);
  const page = useRef<HTMLDivElement>(null);
  return (
    <div className="flex h-dvh overflow-hidden bg-app">
      <div className="hidden h-full flex-none border-r border-line bg-surface md:block" style={{ width: SIDEBAR }} data-witness="sidebar" />
      <div ref={page} className="flex min-w-0 flex-1 flex-col" data-witness="page">
        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          <h1 className="fg-title text-fg">ISS-493 · The page beside the panel</h1>
          <p className="fg-body-sm mt-2 text-muted">The page keeps the width the panel leaves it.</p>
        </main>
      </div>
      <ChatDock dock={dock} page={page} />
    </div>
  );
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const panel = () => q("[data-testid=chat-dock]");
const control = () => q("[data-testid=chat-dock-size]");
const handle = () => q("[data-testid=chat-dock-resize]");
const widthOf = (el: HTMLElement | null) => (el ? Math.round(el.getBoundingClientRect().width) : -1);
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));

/** What the two sizes must be here, read off the page as laid out, not off the code under witness. */
function expected() {
  const pageLeft = Math.round(q("[data-witness=page]")?.getBoundingClientRect().left ?? 0);
  const room = window.innerWidth - pageLeft;
  const large = Math.max(PANEL_FLOOR, room - PAGE_MIN_WIDTH);
  return { room, large, half: Math.round(large / 2) };
}

function at(width: number, label: string): string[] {
  const wrong: string[] = [];
  const w = widthOf(panel());
  if (w !== width) wrong.push(`the panel is ${w} px wide, not the ${label} ${width} px`);
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the window scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

function reads(text: string): string[] {
  const shown = control()?.textContent ?? "no size control";
  return shown === text ? [] : [`the size control reads "${shown}", not "${text}"`];
}

async function click(el: HTMLElement | null) {
  el?.click();
  await frame();
}

async function dragTo(width: number) {
  const h = handle();
  if (!h) return;
  const fire = (type: string, x: number) =>
    h.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1, clientX: x, clientY: 200 }));
  const start = window.innerWidth - widthOf(panel());
  fire("pointerdown", start);
  fire("pointermove", window.innerWidth - width);
  await frame();
  fire("pointerup", window.innerWidth - width);
  await frame();
}

const docked = () => window.innerWidth >= 768;

const stages = docked()
  ? [
      {
        name: "first-open",
        run: () => {
          const { large } = expected();
          const wrong = [...at(large, "large"), ...reads("Large")];
          const pageWidth = widthOf(q("[data-witness=page]"));
          if (large > PANEL_FLOOR && pageWidth !== PAGE_MIN_WIDTH) wrong.push(`the page beside the large panel is ${pageWidth} px, not ${PAGE_MIN_WIDTH}`);
          if (window.localStorage.getItem(DOCK_SIZE_KEY) !== '"large"') wrong.push(`the browser keeps ${window.localStorage.getItem(DOCK_SIZE_KEY)}, not large`);
          if (window.localStorage.getItem(LEGACY_DOCK_WIDTH_KEY) !== null) wrong.push("the old saved width is still there");
          return wrong;
        },
      },
      {
        name: "half",
        run: async () => {
          await click(control());
          const { half } = expected();
          return [...at(half, "half"), ...reads("Half")];
        },
      },
      {
        name: "large-again",
        run: async () => {
          await click(control());
          return [...at(expected().large, "large"), ...reads("Large")];
        },
      },
      {
        name: "dragged",
        run: async () => {
          const { large, half } = expected();
          const between = Math.round((large + half) / 2) + 20;
          await dragTo(between);
          return [...at(between, "dragged"), ...reads(`${between} px`)];
        },
      },
      {
        name: "snapped",
        run: async () => {
          await click(control());
          return [...at(expected().large, "large it snaps to"), ...reads("Large")];
        },
      },
      {
        name: "dragged-past",
        run: async () => {
          const { large, half } = expected();
          await dragTo(window.innerWidth);
          const wrong = at(large, "large a drag past it stops at");
          await dragTo(10);
          return [...wrong, ...at(half, "half a drag below it stops at"), ...reads("Half")];
        },
      },
    ]
  : [
      {
        name: "slide-over",
        run: () => {
          const wrong: string[] = [];
          const body = q("[data-testid=chat-dock-body]");
          if (!body) wrong.push("the panel did not open");
          else {
            // the slide-over's own 1px left border sits between the window's edge and the body
            const { left, right } = body.getBoundingClientRect();
            if (left > 1 || Math.round(right) !== window.innerWidth) wrong.push(`the slide-over spans ${Math.round(left)}–${Math.round(right)} px, not the whole ${window.innerWidth} px window`);
          }
          if (panel()) wrong.push("the panel is docked beside the page on a phone");
          if (control()) wrong.push("a size control is drawn on a phone, where the panel has one size");
          if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the window scrolls sideways: ${document.documentElement.scrollWidth} px`);
          return wrong;
        },
      },
    ];

window.__witness = {
  cases: [
    { name: "dock-390", width: 390 },
    { name: "dock-1280", width: 1280 },
    { name: "dock-1440", width: 1440 },
    { name: "dock-2560", width: 2560 },
  ],
  ready: () => Boolean(q("[data-testid=chat-dock-body]")) && (!docked() || (Boolean(control()) && window.localStorage.getItem(DOCK_SIZE_KEY) !== null)),
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
