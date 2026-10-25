// Feedback from a project's page (REQ-66 BC-1, BC-3, BC-7), witnessed as drawn at phone and desktop
// width, in light and dark: the top bar's Feedback takes the page's screenshot through the browser's
// own renderer before the dialog covers it, the dialog offers the project or Forge, the reporter hides
// part of the screenshot by dragging, a project that redacts asks them to say nothing personal shows,
// and a repeat answers that it joined the open item. Each stage reads what is laid out.
//
//   pnpm --filter web-v2 witness witness/feedback-report.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { CurrentProjectProvider, type ProjectListItem } from "@/features/projects";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { settle, sideways } from "./connect-flow.fixture";
import "./entry";
import { InRouter } from "./router";

const HOP = { id: "p-hop", slug: "hop", name: "HOP clinic" } as ProjectListItem;
const JOINED = {
  created: false,
  filledBy: "agent",
  screenshot: { state: "kept" },
  feedback: { key: "FB-41", title: "The ward board scrolls by itself" },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const posted: { said?: string; whereSeen?: string; screenshot?: { contentBase64?: string; redacted?: boolean } }[] = [];
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if (path === "/version") return json({ version: "0.4.0-dev.320", sourceCommit: null, uptimeSeconds: 60 });
  if (path === "/projects/p-hop/config") return json({ declared: true, revision: 3, document: { sensitiveData: "redact" } });
  if (init?.method === "POST" && path === "/projects/p-hop/feedback/report") {
    posted.push(JSON.parse(String(init.body)));
    return json(JOINED);
  }
  return new Promise<Response>(() => {});
};

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter at="/projects/hop/wards" pattern="/projects/$slug/wards">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CurrentProjectProvider project={HOP}>
        <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
        <main className="grid gap-2 bg-bg p-6 text-fg">
          <h1 className="fg-h3">Ward board</h1>
          <p className="text-13 text-muted">Ward 4 · 12 beds · Updated 2 min ago</p>
          <ul className="border-t border-line-subtle text-13">
            {["Bed 1 · Ann Lee", "Bed 2 · Minh Tran", "Bed 3 · Free", "Bed 4 · Sara Diaz"].map((b) => (
              <li key={b} className="border-b border-line-subtle py-2">
                {b}
              </li>
            ))}
          </ul>
        </main>
      </CurrentProjectProvider>
    </QueryClientProvider>
  </InRouter>,
);

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

function typeInto(el: HTMLTextAreaElement | null, value: string) {
  if (!el) return;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Everything wrong with the open dialog as it is laid out. */
function laidOut(): string[] {
  const wrong = sideways();
  const d = q("[data-testid=report-dialog]");
  if (!d) return ["the button opens no dialog"];
  const r = d.getBoundingClientRect();
  if (r.left < 0 || r.right > window.innerWidth + 0.5) wrong.push("the dialog runs past the window's edge");
  const img = q("[data-testid=report-screenshot] img") as HTMLImageElement | null;
  if (!img) wrong.push("the dialog shows no screenshot");
  else if (!img.complete || img.naturalWidth === 0) wrong.push("the screenshot did not draw");
  if (!d.textContent?.includes("HOP clinic") || !d.textContent?.includes("Forge")) wrong.push("the dialog does not offer the project and Forge");
  const mark = d.querySelector("[role=checkbox]");
  if (!mark) wrong.push("a project that redacts does not ask whether anything personal shows");
  return wrong;
}

async function opened(): Promise<string[]> {
  theme("light");
  q("[data-testid=feedback-open]")?.click();
  for (let i = 0; i < 40 && !q("[data-testid=report-form]"); i += 1) await settle(150);
  await settle(400);
  typeInto(document.querySelector<HTMLTextAreaElement>("[data-testid=report-form] textarea"), "The ward board scrolls to the top by itself");
  await settle();
  return laidOut();
}

/** A drag over the screenshot from one fraction of it to another. */
async function drag(from: [number, number], to: [number, number]) {
  const frame = q("[data-testid=report-screenshot]");
  if (!frame) return;
  const r = frame.getBoundingClientRect();
  const at = ([x, y]: [number, number]) => ({ clientX: r.left + x * r.width, clientY: r.top + y * r.height, pointerId: 1, bubbles: true, isPrimary: true, pointerType: "mouse" });
  // each step is its own render, as a hand's drag is
  frame.dispatchEvent(new PointerEvent("pointerdown", at(from)));
  await settle(50);
  frame.dispatchEvent(new PointerEvent("pointermove", at(to)));
  await settle(50);
  frame.dispatchEvent(new PointerEvent("pointerup", at(to)));
}

async function hidden(): Promise<string[]> {
  const wrong = laidOut();
  await drag([0.05, 0.35], [0.45, 0.7]);
  await settle(200);
  if (document.querySelectorAll("[data-testid=report-mask-box]").length !== 0) wrong.push("a drag hid part of the screenshot before Hide an area was pressed");
  q("[data-testid=report-hide]")?.click();
  await settle(100);
  await drag([0.05, 0.35], [0.45, 0.7]);
  await settle(200);
  if (document.querySelectorAll("[data-testid=report-mask-box]").length !== 1) wrong.push("a drag drew no box over the screenshot");
  (q("[data-testid=report-dialog] [role=checkbox]") as HTMLElement | null)?.click();
  await settle();
  return wrong;
}

async function joined(): Promise<string[]> {
  const send = [...document.querySelectorAll<HTMLButtonElement>("[data-testid=report-form] button")].find((b) => b.textContent === "Send");
  if (!send) return ["the form has no Send"];
  send.click();
  for (let i = 0; i < 40 && !q("[data-testid=report-filed]"); i += 1) await settle(150);
  const note = q("[data-testid=report-filed]");
  if (!note) return ["sending answers with no note"];
  const wrong = sideways();
  if (!note.textContent?.includes("Added to FB-41, already reported.")) wrong.push(`the note reads "${note.textContent}"`);
  const body = posted.at(-1);
  if (body?.whereSeen !== "/projects/hop/wards" && !body?.whereSeen?.startsWith("/")) wrong.push(`the report names the page "${body?.whereSeen}"`);
  if (!body?.screenshot?.contentBase64) wrong.push("the report sent no screenshot");
  if (body?.screenshot?.redacted !== true) wrong.push("the reporter's word that nothing personal shows was not sent");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => Boolean(q("[data-testid=feedback-open]")),
  stages: [
    { name: "1-open-light", run: opened },
    { name: "2-open-dark", run: async () => (theme("dark"), await settle(), laidOut()) },
    { name: "3-hidden-dark", run: hidden },
    { name: "4-hidden-light", run: async () => (theme("light"), await settle(), laidOut()) },
    { name: "5-joined-light", run: joined },
    { name: "6-joined-dark", run: async () => (theme("dark"), await settle(), sideways()) },
  ],
};
