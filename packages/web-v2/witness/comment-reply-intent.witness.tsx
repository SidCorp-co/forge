// An issue thread's reply box, witnessed at desktop and phone width in light and dark: the "Ask as a
// question" tick sits on the box's action row beside Attach, its label one line and readable, and
// the reply it sends says what the person chose — `intent: "note"` unticked, `"question"` ticked,
// as core reads a comment (7f1513341). jsdom lays nothing out and computes no colour, so a tick
// pushed off the row or a label wrapped under its box at 390 px goes red here, not in vitest.
//
//   pnpm --filter web-v2 witness witness/comment-reply-intent.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { CommentThread } from "@/features/issues/components/comment-thread";
import type { CommentNode } from "@/features/issues/types";
import "./entry";
import { InRouter } from "./router";

const AT = new Date(Date.now() - 2 * 3_600_000).toISOString();
const node = (id: string, name: string, body: string, replies: CommentNode[] = []): CommentNode => ({
  id,
  issueId: "i1",
  authorId: `u-${id}`,
  author: { type: "user", id: `u-${id}`, displayName: name, isAgent: false },
  nodes: null,
  record: null,
  intent: "note",
  body,
  format: "markdown",
  template: null,
  parentId: null,
  createdAt: AT,
  updatedAt: AT,
  replies,
  attachments: [],
});
const COMMENTS: CommentNode[] = [
  node("c1", "Ana Pereira", "The export keeps the old column order for the reports clinics already file every week.", [
    node("c2", "Minh Tran", "Agreed — the registry reads columns by position, not by header."),
  ]),
  node("c3", "Lena Vogt", "Landed the header row behind the `export.v2` flag; nothing changes until it is on."),
];

/** Every comment the box posted, as its JSON body. */
const posted: { body: string; intent?: string; parentId?: string }[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://forge.test");
  if (init?.method === "POST" && url.pathname.endsWith("/issues/i1/comments")) {
    const sent = JSON.parse(String(init.body)) as (typeof posted)[number];
    posted.push(sent);
    return json({ ...node(`n${posted.length}`, "You", sent.body), intent: sent.intent ?? "note", parentId: sent.parentId ?? null }, 201);
  }
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/issues/ISS-41">
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-3xl p-4">
        <CommentThread issueId="i1" comments={COMMENTS} members={[]} />
        <p className="mt-4 text-12 text-subtle" data-witness="measured" />
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const all = (sel: string, from: ParentNode = document) => [...from.querySelectorAll<HTMLElement>(sel)];
const REPLY_TEXT = "Does the nightly import read the old order too?";

/** The reply box under the first comment: the second editor (the composer's is first), up to the block holding its tick. */
function replyBox(): HTMLElement | null {
  let at: HTMLElement | null = all(".cm-editor")[1] ?? null;
  while (at && !at.querySelector("[role=checkbox]")) at = at.parentElement;
  return at;
}
const tickIn = (box: HTMLElement) => box.querySelector<HTMLElement>("[role=checkbox]");
const labelOf = (tick: HTMLElement) => tick.closest("label");
const sendIn = (box: HTMLElement) => all("button", box).find((b) => b.textContent?.trim() === "Reply") ?? null;

async function openReply(): Promise<HTMLElement | null> {
  const toggle = all("button.fg-caption").find((b) => b.textContent?.trim() === "Reply");
  toggle?.click();
  for (let i = 0; i < 40 && all(".cm-editor").length < 2; i += 1) await pause(50);
  const box = replyBox();
  const content = box?.querySelector<HTMLElement>(".cm-content");
  if (!box || !content) return null;
  content.focus();
  document.execCommand("insertText", false, REPLY_TEXT);
  await pause(150);
  return box;
}

/** A CSS colour as sRGB, read back from a canvas pixel, so an oklch() token is measured as drawn. */
function rgbOf(css: string): [number, number, number] {
  const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("no 2d canvas");
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gr = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
  return [r, gr, b];
}
const lum = (rgb: [number, number, number]) => {
  const [r = 0, g = 0, b = 0] = rgb.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (fg: string, bg: string) => {
  const [hi = 0, lo = 0] = [lum(rgbOf(fg)), lum(rgbOf(bg))].sort((p, q) => q - p);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

/** The colour an element is drawn on: the nearest background up its ancestors that is not transparent. */
function behind(el: HTMLElement): string {
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    const bg = getComputedStyle(at).backgroundColor;
    if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
  }
  return getComputedStyle(document.body).backgroundColor;
}

/** What is wrong with the reply box as drawn, given whether its tick should be on. */
function drawn(box: HTMLElement | null, ticked: boolean): string[] {
  if (!box) return ["the reply box does not open under a comment"];
  const wrong: string[] = [];
  const width = window.innerWidth;
  if (document.documentElement.scrollWidth > width) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${width}`);
  const tick = tickIn(box);
  if (!tick) return [...wrong, "the reply box has no tick"];
  const label = labelOf(tick);
  if (label?.textContent?.trim() !== "Ask as a question") wrong.push(`the tick is labelled "${label?.textContent?.trim()}", not "Ask as a question"`);
  if ((tick.getAttribute("aria-checked") === "true") !== ticked) wrong.push(`the tick reads ${tick.getAttribute("aria-checked")}, not ${ticked}`);
  const text = label?.querySelector<HTMLElement>(":scope > span:last-child");
  const editor = box.querySelector<HTMLElement>(".cm-editor");
  const send = sendIn(box);
  if (!text || !editor || !send) return [...wrong, "the box's label, editor or send button is not drawn"];
  const t = text.getBoundingClientRect();
  const k = tick.getBoundingClientRect();
  const e = editor.getBoundingClientRect();
  const s = send.getBoundingClientRect();
  const lines = t.height / Number.parseFloat(getComputedStyle(text).lineHeight);
  if (lines > 1.5) wrong.push(`the tick's label wraps to ${Math.round(lines)} lines at ${width} px`);
  if (Math.abs(k.top + k.height / 2 - (t.top + t.height / 2)) > 3) wrong.push("the tick and its label are not on one line");
  if (k.left < e.left - 1 || t.right > e.right + 1) wrong.push(`the tick runs outside the box (${Math.round(k.left)}–${Math.round(t.right)} vs ${Math.round(e.left)}–${Math.round(e.right)})`);
  if (k.top < e.bottom) wrong.push("the tick is drawn over the editor");
  if (t.right > s.left && t.bottom > s.top && t.top < s.bottom) wrong.push("the tick's label runs into the send button");
  if (s.right > width) wrong.push(`the send button is cut off at ${Math.round(s.right)} px in ${width}`);
  const scroller = box.querySelector<HTMLElement>(".cm-scroller");
  if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) wrong.push("the reply editor scrolls sideways instead of wrapping its line");
  const bg = getComputedStyle(document.body).backgroundColor;
  const read = ratio(getComputedStyle(text).color, bg);
  if (read < 4.5) wrong.push(`the tick's label reads ${read}:1 on the page, under 4.5:1`);
  const typed = box.querySelector<HTMLElement>(".cm-line");
  const typedRead = typed ? ratio(getComputedStyle(typed).color, behind(typed)) : 0;
  if (typedRead < 4.5) wrong.push(`what was typed reads ${typedRead}:1 in its box, under 4.5:1`);
  const measured = document.querySelector("[data-witness=measured]");
  if (measured) measured.textContent = `${document.documentElement.dataset.theme ?? "light"} · ${width} px — tick ${ticked ? "on" : "off"}, label ${read}:1, typed ${typedRead}:1, ${Math.round(lines)} line`;
  return wrong;
}

let box: HTMLElement | null = null;

async function sent(intent: "note" | "question"): Promise<string[]> {
  const before = posted.length;
  if (!box) return ["no reply box to send from"];
  sendIn(box)?.click();
  for (let i = 0; i < 40 && posted.length === before; i += 1) await pause(50);
  const last = posted[posted.length - 1];
  if (posted.length === before || !last) return ["the reply box posted nothing"];
  const wrong: string[] = [];
  if (last.intent !== intent) wrong.push(`the reply posted intent ${JSON.stringify(last.intent)}, not "${intent}"`);
  if (last.parentId !== "c1") wrong.push(`the reply posted parentId ${JSON.stringify(last.parentId)}, not the comment it answers`);
  if (last.body !== REPLY_TEXT) wrong.push(`the reply posted body ${JSON.stringify(last.body)}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => all(".cm-editor").length === 1 && all("button").some((b) => b.textContent?.trim() === "Reply"),
  stages: [
    {
      name: "1-unticked-light",
      run: async () => {
        document.documentElement.dataset.theme = "light";
        box = await openReply();
        return drawn(box, false);
      },
    },
    {
      name: "2-ticked-light",
      run: async () => {
        if (box) tickIn(box)?.click();
        await pause(100);
        return drawn(box, true);
      },
    },
    {
      name: "3-ticked-dark",
      run: async () => {
        document.documentElement.dataset.theme = "dark";
        await pause(150);
        return drawn(box, true);
      },
    },
    {
      name: "4-unticked-dark",
      run: async () => {
        if (box) tickIn(box)?.click();
        await pause(100);
        return drawn(box, false);
      },
    },
    { name: "5-sent-note", run: () => sent("note") },
    {
      name: "6-sent-question",
      run: async () => {
        box = await openReply();
        if (box) tickIn(box)?.click();
        await pause(100);
        return [...drawn(box, true), ...(await sent("question"))];
      },
    },
  ],
};
