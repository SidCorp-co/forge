// The Ask Agent panel beside the page, witnessed at a phone, a laptop and wide windows (REQ-31 r2;
// ISS-493): a first open takes the large width, which leaves the page exactly its 480px minimum; the
// size control switches it to half and back; a drag sets a width between, stops at either size, and
// the control snaps it back. With a board open the control names the width drawn and one click moves
// the panel to the size it names, from large and from half, and that is the size kept. The browser
// arrives with a width saved by the old build, which the first open moves to large. On a phone the
// panel is the full-screen slide-over with no size control. Every stage also reads the panel's own
// layout: the title is not cut, no header control leaves the panel, and nothing in it scrolls sideways.
//
//   pnpm --filter web-v2 witness witness/chat-dock.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { WIREFRAME_VERSION } from "@forge/contracts/wireframe";
import { boardStore } from "@/features/board/board-store";
import { DOCK_OPEN_ON_KEY, useChatDockState } from "@/features/chat-dock/dock";
import { DOCK_SIZE_KEY, LEGACY_DOCK_WIDTH_KEY, PAGE_MIN_WIDTH } from "@/features/chat-dock/dock-size";
import { ChatDock } from "@/features/conversations/components/chat-dock";
import "./entry";

const SIDEBAR = 280;
const PANEL_FLOOR = 360;
const BOARD = 880;

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

/** The panel's own layout at whatever width it is drawn: the title whole, every header control inside, no sideways scroll. */
function laidOut(): string[] {
  const wrong: string[] = [];
  const p = panel();
  const header = q("[data-testid=chat-dock-header]");
  const title = header?.querySelector("h2");
  if (!p || !header || !title) return ["the panel has no header to read"];
  const edge = p.getBoundingClientRect();
  if (title.getBoundingClientRect().width < 1) wrong.push("the panel's title is drawn 0 px wide");
  else if (title.scrollWidth > title.clientWidth) wrong.push(`the panel's title is cut: "${title.textContent}" needs ${title.scrollWidth} px and has ${title.clientWidth}`);
  if (header.scrollWidth > header.clientWidth) wrong.push(`the header overflows by ${header.scrollWidth - header.clientWidth} px`);
  const close = header.querySelector<HTMLElement>("button[aria-label^='Close']");
  if (close) {
    const c = close.getBoundingClientRect();
    const h = title.getBoundingClientRect();
    const right = header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight);
    if (Math.abs((c.top + c.bottom) / 2 - (h.top + h.bottom) / 2) > 8 || Math.abs(c.right - right) > 1) wrong.push(`close is not on the title's row at the header's right edge (it sits at ${Math.round(c.left)}, ${Math.round(c.top)})`);
  }
  for (const b of header.querySelectorAll<HTMLElement>("button")) {
    const r = b.getBoundingClientRect();
    if (r.left < edge.left - 0.5 || r.right > edge.right + 0.5) wrong.push(`"${b.getAttribute("aria-label")}" sits outside the panel (${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(edge.left)}–${Math.round(edge.right)})`);
  }
  for (const el of p.querySelectorAll<HTMLElement>("*")) {
    const x = getComputedStyle(el).overflowX;
    if ((x === "auto" || x === "scroll") && el.scrollWidth > el.clientWidth + 1) wrong.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")} scrolls sideways: ${el.scrollWidth} px in ${el.clientWidth}`);
  }
  return wrong;
}

function at(width: number, label: string): string[] {
  const wrong: string[] = [];
  const w = widthOf(panel());
  if (w !== width) wrong.push(`the panel is ${w} px wide, not the ${label} ${width} px`);
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the window scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return [...wrong, ...laidOut()];
}

/** The control names `shown` as the size the panel is at, marks it, and names where a click goes. */
function reads(shown: string, next?: "half" | "large"): string[] {
  const c = control();
  if (!c) return ["no size control"];
  const wrong: string[] = [];
  // a panel under 28rem shows a width between the two sizes by its name alone; the name keeps the px
  const marked = c.querySelector<HTMLElement>("[data-on]")?.innerText ?? "nothing";
  const narrow = widthOf(panel()) < 448;
  const short = shown.replace(/ \(\d+ px\)$/, "");
  if (marked !== (narrow ? short : shown)) wrong.push(`the size control marks "${marked}", not "${narrow ? short : shown}"`);
  for (const size of ["Half", "Large"]) if (!c.querySelector(`[data-segment=${size.toLowerCase()}]`)) wrong.push(`the size control does not show ${size}`);
  const name = c.getAttribute("aria-label") ?? "";
  if (!name.startsWith(`Panel size: ${shown}.`)) wrong.push(`the size control is named "${name}", not for "${shown}"`);
  if (next && !name.endsWith(`Switch to ${next}`)) wrong.push(`the size control is named "${name}", which does not say a click goes to ${next}`);
  return wrong;
}

const kept = () => window.localStorage.getItem(DOCK_SIZE_KEY);
function keeps(size: string): string[] {
  return kept() === JSON.stringify(size) ? [] : [`the browser keeps ${kept()}, not ${size}`];
}

/** What a board widens the panel to from `width`, and how the control must name it, read off the layout. */
function boardOver(width: number) {
  const { large, half } = expected();
  const drawn = Math.max(width, Math.min(large, Math.max(half, BOARD)));
  const shown = drawn === large ? "Large" : drawn === half ? "Half" : `Board (${drawn} px)`;
  const next: "half" | "large" = drawn === large ? "half" : drawn === half ? "large" : drawn - half < large - drawn ? "half" : "large";
  return { drawn, shown, next, to: next === "large" ? large : half };
}

async function setTo(size: "half" | "large") {
  for (let i = 0; i < 3 && control()?.dataset.size !== size; i++) await click(control());
}

/** A board opened over the panel at one size, the control clicked once, then the board closed: one stage each. */
function boardFrom(size: "half" | "large") {
  let want = boardOver(0);
  return [
    {
      name: `board-open-from-${size}`,
      run: async () => {
        boardStore.close();
        await frame();
        await setTo(size);
        const before = widthOf(panel());
        boardStore.load({ v: WIREFRAME_VERSION, shapes: [] });
        await frame();
        want = boardOver(before);
        return [...at(want.drawn, "board-widened"), ...reads(want.shown, want.next)];
      },
    },
    {
      name: `board-click-from-${size}`,
      run: async () => {
        await click(control());
        return [...at(want.to, `${want.next} the click names`), ...keeps(want.next)];
      },
    },
    {
      name: `board-closed-from-${size}`,
      run: async () => {
        boardStore.close();
        await frame();
        return [...at(want.to, `${want.next} kept once the board closes`), ...keeps(want.next)];
      },
    },
  ];
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
          return [...at(between, "dragged"), ...reads(`Custom (${between} px)`)];
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
      ...boardFrom("half"),
      ...boardFrom("large"),
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
    { name: "dock-1024", width: 1024 },
    { name: "dock-1280", width: 1280 },
    { name: "dock-1440", width: 1440 },
    { name: "dock-2120", width: 2120 },
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
