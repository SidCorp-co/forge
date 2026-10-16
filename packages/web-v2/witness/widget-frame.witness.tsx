// The feedback widget's frame, witnessed at the loader's iframe size (380 × 560) and full-screen on a
// phone, in light and dark: the gate, a conversation with a draft to confirm, the sent report with its
// status link, and a limit met. jsdom lays nothing out, so what only a width or a height shows is
// measured here: nothing scrolls sideways, the composer stays inside the frame, and the binding's
// accent is the primary button's colour with its ink at 4.5:1 or more.
//
//   pnpm --filter web-v2 witness witness/widget-frame.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { WidgetFrame } from "@/features/widget";
import "./entry";

const SITE_KEY = `fw_site_${"k".repeat(32)}`;
const TOKEN = `fw_sess_${"s".repeat(43)}`;
const ACCENT = "#0f766e";
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

// each case is a first visit: no visitor kept from the case before it
window.localStorage.clear();
let write: ((event: unknown) => void) | null = null;
const at = (s: number) => new Date(Date.UTC(2026, 9, 16, 10, 0, s)).toISOString();

window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname.replace(/^\/api\/widget/, "");
  const method = init?.method ?? "GET";
  if (path === `/${SITE_KEY}/config`)
    return json({ title: "Kettle Co. help", greeting: "Hi! Tell us what went wrong and we'll pass it on.", accent: ACCENT, identity: { mode: "anonymous" }, messageMaxChars: 4000 });
  if (path === `/${SITE_KEY}/sessions`) return json({ sessionToken: TOKEN, visitorId: crypto.randomUUID(), conversationId: "c1", expiresAt: at(59) });
  if (path === "/session/messages" && method === "GET") return json({ messages: [], drafts: [] });
  if (path === "/session/messages") return json({ id: crypto.randomUUID(), role: "visitor", text: "x", at: at(1) });
  if (path === "/session/drafts/d1/confirm") return json({ feedbackKey: "FB-31", statusUrl: `/w/status/fw_stat_${"x".repeat(43)}` });
  if (path === "/session/stream") {
    const encoder = new TextEncoder();
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({ start: (c) => void (write = (e) => c.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))) }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  }
  return json({ code: "WIDGET_REFUSED", message: "unexpected" }, 422);
};

// the loader's iframe is 380 × 560 on a desktop page; on a phone it fills the screen
const width = () => (window.innerWidth >= 1024 ? window.innerWidth : screen.width);
if (width() < 385) {
  const style = document.createElement("style");
  style.textContent = "[data-testid=widget-frame]{height:560px!important}";
  document.head.appendChild(style);
}

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <WidgetFrame siteKey={SITE_KEY} />
  </QueryClientProvider>,
);

const settle = (ms = 200) => new Promise((ok) => setTimeout(ok, ms));
const frame = () => document.querySelector<HTMLElement>("[data-testid=widget-frame]");
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

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

/** What is wrong with the frame as drawn now. */
function measure(primary?: string): string[] {
  const wrong: string[] = [];
  const f = frame();
  if (!f) return ["no frame is drawn"];
  if (document.documentElement.scrollWidth > width()) wrong.push(`the frame scrolls sideways: ${document.documentElement.scrollWidth} px in ${width()}`);
  const box = f.getBoundingClientRect();
  const composer = document.querySelector<HTMLElement>("[data-testid=widget-composer]");
  if (composer && composer.getBoundingClientRect().bottom > box.bottom + 1) wrong.push("the composer falls below the frame");
  if (width() < 385 && Math.round(box.height) !== 560) wrong.push(`the frame is ${Math.round(box.height)} px tall, not the iframe's 560`);
  const b = primary ? button(primary) : undefined;
  if (primary && !b) wrong.push(`no ${primary} button is drawn`);
  if (b) {
    const bg = getComputedStyle(b).backgroundColor;
    if (rgbOf(bg).join() !== rgbOf(ACCENT).join()) wrong.push(`${primary} is drawn in ${bg}, not the binding's accent`);
    const ink = ratio(getComputedStyle(b).color, bg);
    if (ink < 4.5) wrong.push(`${primary}'s ink reads ${ink}:1 on the accent, under 4.5:1`);
  }
  for (const bubble of document.querySelectorAll<HTMLElement>("[data-role] > div")) {
    const style = getComputedStyle(bubble);
    const read = ratio(style.color, style.backgroundColor);
    if (read < 4.5) wrong.push(`a ${bubble.parentElement?.dataset.role} line reads ${read}:1 on its bubble, under 4.5:1`);
  }
  return wrong;
}

const inTheme = (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
};

window.__witness = {
  cases: [
    { name: "iframe-380", width: 380 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(button("Start chat")),
  stages: [
    {
      name: "gate-light",
      run: () => {
        inTheme("light");
        return measure("Start chat");
      },
    },
    {
      name: "gate-dark",
      run: () => {
        inTheme("dark");
        return measure("Start chat");
      },
    },
    {
      name: "draft-light",
      run: async () => {
        inTheme("light");
        button("Start chat")?.click();
        await settle(400);
        write?.({ type: "message", message: { id: "v1", role: "visitor", text: "The Pay button on my cart does nothing.", at: at(1) } });
        write?.({ type: "message", message: { id: "a1", role: "assistant", text: "Sorry about that. What did you expect to happen when you pressed it?", at: at(2) } });
        write?.({ type: "message", message: { id: "v2", role: "visitor", text: "To go to the payment page.", at: at(3) } });
        write?.({
          type: "draft",
          draft: {
            draftId: "d1",
            title: "Pay button on the cart does nothing",
            did: "Pressed Pay on the cart page",
            saw: "Nothing happened, no error",
            expected: "The payment page to open",
            whereSeen: "/cart",
            kind: "bug",
            state: "pending",
          },
        });
        await settle(300);
        return document.querySelector("[data-testid=widget-draft]") ? measure("Send report") : ["the draft is not drawn"];
      },
    },
    {
      name: "draft-dark",
      run: () => {
        inTheme("dark");
        return measure("Send report");
      },
    },
    {
      name: "filed-dark",
      run: async () => {
        button("Send report")?.click();
        await settle(300);
        return document.querySelector("[data-testid=widget-status-link]") ? measure("Copy link") : ["the status link is not drawn"];
      },
    },
    {
      name: "filed-light",
      run: () => {
        inTheme("light");
        return measure("Copy link");
      },
    },
    {
      name: "limit-light",
      run: async () => {
        write?.({ type: "limit", code: "WIDGET_LIMIT_REACHED", detail: "This conversation reached its 30 turns." });
        await settle(200);
        return document.querySelector("[data-testid=widget-limit]") ? measure() : ["the limit is not drawn"];
      },
    },
  ],
};
