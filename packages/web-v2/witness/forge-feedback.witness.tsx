// Feedback to Forge (REQ-47 BC-9), witnessed as drawn: the shell's top bar offers it on a project's
// page — named at desktop width, an icon at phone width — and its form opens over the page, files as
// the signed-in person into Forge's home project and answers with the item's key and a link to "Your
// feedback to Forge". Each stage reads what is laid out, never the component's state.
//
//   pnpm --filter web-v2 witness witness/forge-feedback.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { CurrentProjectProvider, type ProjectListItem } from "@/features/projects";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { settle, sideways } from "./connect-flow.fixture";
import "./entry";
import { InRouter } from "./router";

const HOP = { id: "p-hop", slug: "hop", name: "HOP" } as ProjectListItem;
const FILED = {
  created: true,
  feedback: {
    key: "FB-212",
    title: "The board drops a card dragged to Done",
    kind: "bug",
    severity: "medium",
    phase: "new",
    route: null,
    origin: null,
    createdAt: "2026-10-21T08:00:00.000Z",
    updatedAt: "2026-10-21T08:00:00.000Z",
    progress: { says: "Waiting to be triaged.", running: false, eta: { estimate: false } },
  },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const posted: unknown[] = [];
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if (path === "/version") return json({ version: "0.4.0-dev.260", sourceCommit: null, uptimeSeconds: 60 });
  if (init?.method === "POST" && path === "/forge/feedback") {
    posted.push(JSON.parse(String(init.body)));
    return json(FILED, 201);
  }
  return new Promise<Response>(() => {});
};

// the page's query is the window's own (`useLocationSearch`), which the memory router does not set
window.history.replaceState(null, "", `${window.location.pathname}?status=open`);

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter at="/projects/hop/issues?status=open" pattern="/projects/$slug/issues">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CurrentProjectProvider project={HOP}>
        <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
        <main style={{ padding: 24 }} className="text-13 text-muted">
          Issues of HOP
        </main>
      </CurrentProjectProvider>
    </QueryClientProvider>
  </InRouter>,
);

const opener = () => document.querySelector<HTMLButtonElement>("[data-testid=forge-feedback-open]");
const dialog = () => document.querySelector<HTMLElement>("[data-testid=forge-feedback-dialog]");
const phone = () => window.innerWidth < 640;

function typeInto(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!el) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function bar(): string[] {
  const b = opener();
  if (!b) return ["the top bar draws no Feedback to Forge entry"];
  const wrong = sideways();
  const r = b.getBoundingClientRect();
  if (r.width === 0 || r.right > window.innerWidth) wrong.push("the Feedback to Forge entry is not inside the window");
  const label = b.querySelector("span:not(.sr-only)")?.textContent ?? b.textContent ?? "";
  if (!phone() && !label.includes("Feedback to Forge")) wrong.push(`the entry reads "${label}" at desktop width`);
  if (b.getAttribute("aria-label") !== "Feedback to Forge") wrong.push("the entry has no accessible name");
  return wrong;
}

async function form(): Promise<string[]> {
  opener()?.click();
  await settle(300);
  const d = dialog();
  if (!d) return ["the button opens no dialog"];
  typeInto(d.querySelector("input"), "The board drops a card dragged to Done");
  typeInto(d.querySelector("textarea"), "Dragging a card from Review to Done makes it vanish until the page is reloaded.");
  await settle();
  const wrong = sideways();
  const where = d.querySelector("[data-testid=forge-feedback-where]")?.textContent ?? "";
  if (!where.includes("/projects/hop/issues?status=open")) wrong.push(`the form says it was seen at "${where}"`);
  const r = d.getBoundingClientRect();
  if (r.left < 0 || r.right > window.innerWidth) wrong.push("the dialog runs past the window's edge");
  return wrong;
}

async function filed(): Promise<string[]> {
  const send = [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Send to Forge");
  if (!send) return ["the form has no Send to Forge"];
  send.click();
  await settle(400);
  const note = document.querySelector("[data-testid=forge-feedback-filed]");
  if (!note) return ["filing answers with no note"];
  const wrong: string[] = [];
  if (!note.textContent?.includes("FB-212 filed.")) wrong.push(`the note reads "${note.textContent}"`);
  const link = note.querySelector("a");
  if (link?.getAttribute("href") !== "/forge-feedback") wrong.push("the note does not link to Your feedback to Forge");
  const body = posted[0] as { from?: { project?: string }; clientVersion?: string } | undefined;
  if (body?.from?.project !== "p-hop") wrong.push("the report does not name the project it came from");
  if (body?.clientVersion !== "web 0.4.0-dev.260") wrong.push(`the report names client "${body?.clientVersion}", not the version the shell read`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => Boolean(opener()),
  stages: [
    { name: "bar", run: bar },
    { name: "form", run: form },
    { name: "filed", run: filed },
  ],
};
