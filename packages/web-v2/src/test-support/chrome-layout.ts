// Lays a page out in a real Chrome and reports whether each control in a table's body can be scrolled
// fully clear of the table's sticky column. jsdom has no layout, so a test of "can a phone user reach
// this button" can only be run where a layout engine is: a width cap that is wrong reads green there.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { type ChromeSession, launchChrome, within, WARM_HOOK_MS, WARM_LAUNCH_MS, WARM_STYLESHEET_MS } from "./chrome-session";

export { WARM_HOOK_MS, WARM_LAUNCH_MS, WARM_STYLESHEET_MS };

const WEB_V2 = resolve(__dirname, "../..");

let stylesheet: Promise<string> | undefined;

/** The app's own stylesheet, compiled from `globals.css` over every class the sources use. */
export function appStylesheet(): Promise<string> {
  stylesheet ??= (async () => {
    const from = join(WEB_V2, "src/app/globals.css");
    const result = await postcss([tailwind({ base: WEB_V2 }) as never]).process(readFileSync(from, "utf8"), { from });
    return result.css;
  })();
  return stylesheet;
}

export interface WarmOptions {
  chrome?: string;
  launchMs?: number;
  stylesheetMs?: number;
}

let session: Promise<ChromeSession> | undefined;
let launches = 0;

export const chromeLaunches = () => launches;

/**
 * Pays what a first Chrome-backed case would otherwise pay inside its own test timeout: the app's
 * stylesheet compile and the browser's launch, each on its own clock, failing with what it was
 * waiting for. The browser it leaves running is the one every `measureReach` after it uses. Call it
 * from `beforeAll` with `WARM_HOOK_MS` and `closeChrome` from `afterAll`.
 */
export function warmChrome(options: WarmOptions = {}): Promise<ChromeSession> {
  session ??= (async () => {
    await within("Compiling the app stylesheet for the layout tests", options.stylesheetMs ?? WARM_STYLESHEET_MS, appStylesheet());
    launches += 1;
    return launchChrome({ chrome: options.chrome, launchMs: options.launchMs ?? WARM_LAUNCH_MS });
  })();
  session.catch(() => {
    session = undefined;
  });
  return session;
}

/** The browser `warmChrome` left running; a case that asks before it was warmed is refused by name. */
export function runningChrome(): Promise<ChromeSession> {
  if (!session) {
    throw new Error("A Chrome case ran before warmChrome(): call it from beforeAll with WARM_HOOK_MS, so no case carries the launch inside its own timeout.");
  }
  return session;
}

export async function closeChrome(): Promise<void> {
  const running = session;
  session = undefined;
  if (running) await (await running.catch(() => undefined))?.close();
}

export interface Measured {
  reach: Reach[];
  /** Sticky cells whose content spills out of the cell, over the columns beside it. */
  overflowing: string[];
  /** The widest a sticky cell came out, per table label, in px. */
  stickyWidest: Record<string, number>;
  /** Controls inside a sticky cell, which are always in view, and whether each sits inside its cell. */
  pinned: { table: string; control: string; fits: boolean }[];
  /** Words in a sticky cell that the cell broke across lines, mid-word, so a name does not read whole. */
  broken: string[];
  /** Text a sticky cell cuts off with an ellipsis, and whether the whole of it is in a `title`. */
  clipped: { table: string; text: string; titled: boolean }[];
  /** Tables whose scroller has to scroll sideways, with by how much. */
  scrolling: string[];
  /** How many lines each pill in a table body takes, by its text. */
  pillLines: Record<string, number>;
  /** Each pill in a table body: whether the table's frame holds it unscrolled, and whether a title carries its whole text. */
  pills: { table: string; text: string; framed: boolean; titled: boolean }[];
  /** Tables with a frame of their own whose header does not stay at the top of it when the rows scroll under it. */
  headerLost: string[];
  /** How many rows each table draws in its body, by label. */
  bodyRows: Record<string, number>;
}

export interface Reach {
  table: string;
  control: string;
  /** The control's edges after it was scrolled as far toward view as the table lets it go. */
  left: number;
  right: number;
  /** The edges of the area the sticky column leaves it. */
  clearFrom: number;
  clearTo: number;
  clear: boolean;
  /** Whether the control sits inside the table's frame before anything is scrolled. */
  framed: boolean;
}

// Runs in the page. Each control is scrolled as close to view as its table allows, then measured.
const MEASURE = `
const out = [];
const overflowing = [];
const stickyWidest = {};
const pinned = [];
const broken = [];
const clipped = [];
const scrolling = [];
const pillLines = {};
const pills = [];
const headerLost = [];
const bodyRows = {};
for (const table of document.querySelectorAll("table")) {
  const scroller = table.parentElement;
  const sticky = table.querySelector("tbody td.sticky");
  const label = table.getAttribute("aria-label") || "table";
  const max = scroller.scrollWidth - scroller.clientWidth;
  if (max > 1) scrolling.push(label + ": " + max + "px");
  bodyRows[label] = table.querySelectorAll("tbody tr[data-index]").length || table.querySelectorAll("tbody tr").length;
  for (const pill of table.querySelectorAll("tbody span.rounded-pill")) {
    const range = document.createRange();
    range.selectNodeContents(pill);
    const text = pill.textContent.trim();
    pillLines[text] = Math.max(pillLines[text] || 0, new Set(Array.from(range.getClientRects(), (r) => Math.round(r.top))).size);
    scroller.scrollLeft = 0;
    const at = pill.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const holder = pill.querySelector("[title]");
    pills.push({ table: label, text, framed: at.left >= view.left - 0.5 && at.right <= view.right + 0.5, titled: holder !== null && holder.getAttribute("title") === text });
  }
  if (scroller.scrollHeight > scroller.clientHeight + 1) {
    scroller.scrollTop = 200;
    const head = table.querySelector("thead th");
    if (Math.abs(head.getBoundingClientRect().top - scroller.getBoundingClientRect().top) > 1) headerLost.push(label);
    scroller.scrollTop = 0;
  }
  for (const cell of table.querySelectorAll("td.sticky, th.sticky")) {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const word of node.textContent.matchAll(/\\S+/g)) {
        const range = document.createRange();
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        const lines = new Set(Array.from(range.getClientRects(), (r) => Math.round(r.top)));
        if (lines.size > 1) broken.push(label + ": " + word[0] + " over " + lines.size + " lines");
      }
    }
    for (const el of cell.querySelectorAll("*")) {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === "ellipsis") {
        const whole = el.textContent.trim();
        const holder = el.closest("[title]");
        clipped.push({ table: label, text: whole, titled: holder !== null && holder.getAttribute("title") === whole });
      }
    }
  }
  for (const cell of table.querySelectorAll("td.sticky")) {
    stickyWidest[label] = Math.max(stickyWidest[label] || 0, Math.round(cell.getBoundingClientRect().width));
    if (cell.scrollWidth > cell.clientWidth + 1) overflowing.push(label + ": " + cell.textContent.trim().slice(0, 40));
  }
  for (const el of table.querySelectorAll("tbody button, tbody a")) {
    const home = el.closest("td.sticky");
    if (home) {
      const a = el.getBoundingClientRect();
      const c = home.getBoundingClientRect();
      pinned.push({ table: label, control: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40), fits: a.left >= c.left - 0.5 && a.right <= c.right + 0.5 });
      continue;
    }
    scroller.scrollLeft = 0;
    const box = el.getBoundingClientRect();
    if (box.width === 0) continue;
    const view = scroller.getBoundingClientRect();
    const framed = box.left >= view.left - 0.5 && box.right <= view.right + 0.5;
    const edge = sticky ? sticky.getBoundingClientRect().right - view.left : 0;
    const toward = box.right - view.left - scroller.clientWidth;
    scroller.scrollLeft = Math.min(max, Math.max(0, toward));
    const at = el.getBoundingClientRect();
    const now = scroller.getBoundingClientRect();
    const clearFrom = now.left + (sticky ? sticky.getBoundingClientRect().width : 0);
    out.push({
      table: label,
      control: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
      left: Math.round(at.left - now.left),
      right: Math.round(at.right - now.left),
      clearFrom: Math.round(clearFrom - now.left),
      clearTo: Math.round(now.right - now.left),
      clear: at.left >= clearFrom - 0.5 && at.right <= now.right + 0.5,
      framed,
    });
  }
}
parent.postMessage(btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ viewport: innerWidth, out, overflowing, stickyWidest, pinned, broken, clipped, scrolling, pillLines, pills, headerLost, bodyRows })))), "*");
`;

/**
 * Lays \`markup\` out in a column \`width\` px wide inside a viewport \`viewport\` px wide, so the
 * responsive utilities answer for that screen, and measures every table in it. Chrome will not make a
 * window narrower than 500px, so the page is a frame \`viewport\` wide: a frame is its own viewport.
 */
export async function measureReach(markup: string, width: number, viewport: number): Promise<Measured> {
  if (!session) {
    throw new Error("measureReach ran before warmChrome(): call it from beforeAll with WARM_HOOK_MS, so no case carries the launch inside its own timeout.");
  }
  const chrome = await runningChrome();
  const css = await appStylesheet();
  const inner = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body style="margin:0"><div style="width:${width}px">${markup}</div><script>${MEASURE}</script></body></html>`;
  const outer = `<!doctype html><html><body style="margin:0"><iframe src="inner.html" style="width:${viewport}px;height:1200px;border:0"></iframe><pre id="reach"></pre><script>addEventListener("message", (e) => { document.getElementById("reach").textContent = e.data; });</script></body></html>`;
  const dir = mkdtempSync(join(tmpdir(), "forge-chrome-layout-"));
  try {
    writeFileSync(join(dir, "inner.html"), inner);
    writeFileSync(join(dir, "outer.html"), outer);
    const body = await chrome.evaluateWhenReady(`file://${join(dir, "outer.html")}`, 'document.getElementById("reach")?.textContent ?? ""', 20_000);
    if (!body) throw new Error("Chrome laid the page out but reported no measurement: the frame's script did not run.");
    // The report crosses as base64, so no `&`, `<` or `"` in it needs unescaping and nothing is unescaped here.
    const text = Buffer.from(body, "base64").toString("utf8");
    const measured = JSON.parse(text) as { viewport: number; out: Reach[]; overflowing: string[]; stickyWidest: Record<string, number>; pinned: Measured["pinned"]; broken: string[]; clipped: Measured["clipped"]; scrolling: string[]; pillLines: Record<string, number>; pills: Measured["pills"]; headerLost: string[]; bodyRows: Record<string, number> };
    if (measured.viewport !== viewport) {
      throw new Error(`Chrome laid the page out in a ${measured.viewport}px viewport, not the ${viewport}px asked for, so the responsive classes answered for another screen.`);
    }
    return { reach: measured.out, overflowing: measured.overflowing, stickyWidest: measured.stickyWidest, pinned: measured.pinned, broken: measured.broken, clipped: measured.clipped, scrolling: measured.scrolling, pillLines: measured.pillLines, pills: measured.pills, headerLost: measured.headerLost, bodyRows: measured.bodyRows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
