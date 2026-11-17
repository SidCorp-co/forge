// The feedback widget's frame as a host page embeds it, the page naming its visitor's locale (`vi`):
// full-screen on a 390 × 844 phone, where the loader hides its launcher and the frame's own close is
// the way back to the page, and in the loader's 380 × 560 panel on a 1440 desktop page, in light and
// dark. Each stage logs the words the frame shows, so a change in what it says is counted.
//
//   pnpm --filter web-v2 witness witness/widget-locale.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { WidgetFrame } from "@/features/widget";
import "./entry";

const SITE_KEY = `fw_site_${"k".repeat(32)}`;
const TOKEN = `fw_sess_${"s".repeat(43)}`;
const HOST = "https://shop.example.com";
const LOCALE = "vi";
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const at = (s: number) => new Date(Date.UTC(2026, 10, 17, 10, 0, s)).toISOString();

window.localStorage.clear();
let write: ((event: unknown) => void) | null = null;

window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname.replace(/^\/api\/widget/, "");
  const method = init?.method ?? "GET";
  if (path === `/${SITE_KEY}/config`)
    return json({ title: "ePOD", greeting: null, greetings: {}, accent: null, identity: { mode: "anonymous" }, messageMaxChars: 4000 });
  if (path === `/${SITE_KEY}/sessions`) return json({ sessionToken: TOKEN, visitorId: crypto.randomUUID(), conversationId: "c1", expiresAt: at(59) });
  if (path === "/session/messages" && method === "GET") return json({ messages: [], drafts: [] });
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

// The frame is embedded: its parent is a window of its own (a blank iframe standing in for the host
// page) at the host's origin, so the frame draws what only an embedded frame draws, its close.
const hostFrame = document.createElement("iframe");
hostFrame.style.display = "none";
document.body.appendChild(hostFrame);
const hostWindow = hostFrame.contentWindow;
if (!hostWindow) throw new Error("the stand-in host window did not open");
Object.defineProperty(window, "parent", { value: hostWindow, configurable: true });
Object.defineProperty(document, "referrer", { value: `${HOST}/`, configurable: true });

const desktop = window.innerWidth >= 1024;
const style = document.createElement("style");
style.textContent = desktop
  ? // the loader's panel on a desktop page: 380 × 560, 20 px from the right, above the launcher
    `body{background:repeating-linear-gradient(0deg,#f4f4f5 0 48px,#e4e4e7 48px 49px)}
     #root{position:fixed;right:20px;bottom:88px;width:380px;height:560px;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.28)}
     [data-testid=widget-frame]{height:560px!important}`
  : "";
document.head.appendChild(style);

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <WidgetFrame siteKey={SITE_KEY} />
  </QueryClientProvider>,
);

/** What the host page's loader sends: its context, the locale among it, and that the frame is open. */
function hostSays(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent("message", { data: { source: "forge-widget", ...data }, origin: HOST, source: hostWindow }));
}
setTimeout(() => {
  hostSays({ type: "context", context: { url: `${HOST}/orders`, locale: LOCALE } });
  hostSays({ type: "open" });
}, 50);

const settle = (ms = 200) => new Promise((ok) => setTimeout(ok, ms));
const frame = () => document.querySelector<HTMLElement>("[data-testid=widget-frame]");
const start = () => document.querySelector<HTMLButtonElement>("[data-testid=widget-gate] button[type=submit]");
const WORD = /[\p{L}\p{N}]+(?:['’.\-/:][\p{L}\p{N}]+)*/gu;

/** The frame's visible words, logged for the run's output, and what is wrong with its close. */
function measure(stage: string): string[] {
  const f = frame();
  if (!f) return ["no frame is drawn"];
  const words = (f.innerText.match(WORD) ?? []).length;
  console.log(`${window.innerWidth}px ${stage}: ${words} visible words`);
  const wrong: string[] = [];
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px`);
  const close = f.querySelector<HTMLElement>("header button");
  if (!close) wrong.push("the frame draws no close");
  else {
    const box = close.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) wrong.push(`the close is ${Math.round(box.width)} × ${Math.round(box.height)} px, under a 40 px target`);
  }
  return wrong;
}

const inTheme = (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
};

window.__witness = {
  cases: [
    { name: "phone-390", width: 390, height: 844 },
    { name: "desktop-1440", width: 1440 },
  ],
  ready: () => Boolean(start()),
  stages: [
    {
      name: "gate-light",
      run: async () => {
        await settle(150);
        inTheme("light");
        return measure("gate");
      },
    },
    {
      name: "gate-dark",
      run: () => {
        inTheme("dark");
        return measure("gate");
      },
    },
    {
      name: "chat-dark",
      run: async () => {
        start()?.click();
        await settle(400);
        write?.({ type: "message", message: { id: "v1", role: "visitor", text: "Đơn hàng của tôi không in được nhãn.", at: at(1) } });
        write?.({ type: "message", message: { id: "a1", role: "assistant", text: "Bạn bấm In nhãn ở trang nào vậy?", at: at(2) } });
        write?.({
          type: "draft",
          draft: { draftId: "d1", title: "Không in được nhãn đơn hàng", did: "Bấm In nhãn", saw: "Không có gì xảy ra", expected: "Nhãn được in", whereSeen: "/orders", kind: "bug", state: "pending" },
        });
        await settle(300);
        return document.querySelector("[data-testid=widget-draft]") ? measure("chat") : ["the draft is not drawn"];
      },
    },
    {
      name: "chat-light",
      run: () => {
        inTheme("light");
        return measure("chat");
      },
    },
  ],
};
