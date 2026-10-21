// A requirement's mockups as a person meets them (REQ-49), at desktop and phone width: listed under
// the requirement's properties with Add mockup (BC-7); opened full screen from that row, running its
// own scripts in the isolated frame (BC-1); a comment pinned to a point of it, shown at that point and
// saying where it points (BC-2); and its revisions, the earlier one readable with the comments its
// successor settled (BC-3) — last in the dark theme. jsdom lays nothing out and runs no frame, so
// "full screen", "runs" and "at that point" go red only here.
//
// The mockup is a real page read from `<out>/mockup-fixture.js`, since Chrome reaches no file but the
// ones beside the page: write it there before the run from any HTML page.
//
//   node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2]+"/mockup-fixture.js","window.__mockupHtml="+JSON.stringify(fs.readFileSync(process.argv[1],"utf8")))' <page.html> <dir>
//   pnpm --filter web-v2 witness witness/mockups-on-the-item.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { MockupCommentView, MockupView } from "@/features/mockups/types";
import { ChatDockProvider, useChatDockState } from "@/features/chat-dock/dock";
import { MockupFeedback } from "@/features/feedback";
import { RequirementPage } from "@/features/requirements/components/requirement-detail";
import { reqDetail } from "@/test/vi-chrome-requirements";
import { settle, sideways, windowWidth } from "./connect-flow.fixture";
import "./entry";
import { InRouter } from "./router";

declare global {
  interface Window {
    __mockupHtml?: string;
  }
}

const P = "7f1c1d1e-0000-4000-8000-000000000049";
const AT = "2026-10-21T08:00:00.000Z";
const NOBODY = { accept: false, return: false, withdraw: false, comment: false, revise: false };

const mockup = (key: string, over: Partial<MockupView>): MockupView => ({
  id: key,
  key,
  target: { type: "requirement", key: "REQ-1", revision: 1 },
  kind: "html",
  name: "approvals.html",
  mime: "text/html",
  size: 75_588,
  caption: "Approvals inbox",
  status: "proposed",
  proposedBy: "u-ba",
  proposedByName: "BA assistant",
  proposedAgency: "agent",
  createdAt: AT,
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  reason: null,
  pinned: null,
  round: 1,
  revises: null,
  revisedBy: null,
  comments: { total: 0, open: 0 },
  url: `/api/projects/${P}/mockups/${key}/content`,
  can: { accept: true, return: true, withdraw: false, comment: true, revise: false },
  ...over,
});

const rows = [
  mockup("MK-1", { status: "returned", reason: "The bulk bar hides the first row", decidedByName: "Lan", revisedBy: "MK-2", comments: { total: 2, open: 0 }, can: NOBODY }),
  mockup("MK-2", { round: 2, revises: "MK-1", createdAt: "2026-10-21T09:00:00.000Z", comments: { total: 2, open: 0 } }),
];

const said = (id: string, on: string, body: string, over: Partial<MockupCommentView>): MockupCommentView => ({
  id,
  on,
  body,
  pin: null,
  authorId: "u-lan",
  authorName: "Lan",
  authorAgency: "human",
  createdAt: "2026-10-21T08:30:00.000Z",
  settled: null,
  ...over,
});
const thread: MockupCommentView[] = [
  said("c1", "MK-1", "The bulk bar sits over the first row; move it above the list.", {
    pin: { x: 0.08, y: 0.18, w: 0.5, h: 0.08 },
    settled: { as: "answered", by: "MK-2", note: "Bar moved above the list", at: "2026-10-21T09:00:00.000Z" },
  }),
  said("c2", "MK-1", "Can the age column sort?", { settled: { as: "resolved", by: "MK-2", note: "Sorting is the list's, not this screen's", at: "2026-10-21T09:00:00.000Z" } }),
];

// the fixture page, and a line that tells this page its scripts ran inside the frame
const ran: string[] = [];
window.addEventListener("message", (e) => {
  if (typeof e.data === "object" && e.data && "mockupRan" in e.data) ran.push(String(e.data.mockupRan));
});
const fixture = new Promise<string>((ok) => {
  const s = document.createElement("script");
  s.src = "mockup-fixture.js";
  s.onload = () => ok(window.__mockupHtml ?? "");
  s.onerror = () => ok("");
  document.head.append(s);
});
const BEACON = `<script>parent.postMessage({ mockupRan: document.title || "untitled" }, "*")</script>`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  const method = init?.method ?? "GET";
  if (path.endsWith("/content")) {
    const html = await fixture;
    const page = html.includes("</body>") ? html.replace("</body>", `${BEACON}</body>`) : `${html}${BEACON}`;
    return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
  }
  if (path.endsWith("/comments") && method === "POST") {
    const body = JSON.parse(String(init?.body)) as { body: string; pin?: MockupCommentView["pin"] };
    const c = said(`c${thread.length + 1}`, "MK-2", body.body, { pin: body.pin ?? null, createdAt: new Date().toISOString() });
    thread.push(c);
    return json({ comment: c }, 201);
  }
  if (path.endsWith("/comments")) return json({ comments: thread, open: thread.filter((c) => !c.settled).length });
  if (path === `/projects/${P}/mockups`) return json({ mockups: rows, returned: rows.length, open: 1 });
  return new Promise<Response>(() => {});
};

/** The page beside the Ask Agent panel, as the app mounts it, so the viewer offers a chat about the mockup. */
function WithDock({ children }: { children: ReactNode }) {
  return (
    <ChatDockProvider value={useChatDockState(P)}>
      <MockupFeedback>{children}</MockupFeedback>
    </ChatDockProvider>
  );
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["requirement", P, "REQ-1"], { ...reqDetail, title: "Approvals inbox lists what waits on a person" });
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/requirements/REQ-1" pattern="/projects/$slug/requirements/$requirement">
    <QueryClientProvider client={client}>
      <WithDock>
        <div className="min-h-screen bg-app text-fg">
          <RequirementPage projectId={P} slug="hop" reqKey="REQ-1" tab="overview" onTab={() => {}} />
        </div>
      </WithDock>
    </QueryClientProvider>
  </InRouter>,
);

const q = <T extends Element = HTMLElement>(sel: string, from: ParentNode = document) => from.querySelector<T>(sel);
const all = (sel: string, from: ParentNode = document) => [...from.querySelectorAll<HTMLElement>(sel)];

async function until(test: () => boolean, what: string, tries = 80): Promise<string[]> {
  for (let i = 0; i < tries; i += 1) {
    if (test()) return [];
    await settle(50);
  }
  return [`${what} is not drawn`];
}

function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The viewer fills the window: full screen, not a panel inside the page. */
function fillsTheWindow(): string[] {
  const viewer = q("[data-testid=mockup-viewer]");
  if (!viewer) return ["the full-screen viewer is not open"];
  const r = viewer.getBoundingClientRect();
  const short = windowWidth() - r.width > 2 || window.innerHeight - r.height > 2;
  return short ? [`the viewer is ${Math.round(r.width)} x ${Math.round(r.height)} in a ${windowWidth()} x ${window.innerHeight} window`] : [];
}

async function onTheRequirement(): Promise<string[]> {
  document.documentElement.dataset.theme = "light";
  // below 1024 px the rail stands behind the page's Facts disclosure, which names the mockups among its groups
  const toggle = q<HTMLButtonElement>("[data-testid=rail-facts-toggle]");
  const wrong: string[] = [];
  if (toggle && toggle.getBoundingClientRect().width > 0) {
    const groups = q("[data-testid=rail-facts-groups]")?.textContent ?? "";
    if (!groups.includes("Mockups")) wrong.push(`the Facts disclosure names ${groups}, not the mockups`);
    toggle.click();
  }
  wrong.push(...(await until(() => all("[data-testid=requirement-mockup]").some((r) => r.getBoundingClientRect().height > 0), "the requirement's mockup list")));
  const group = q("[data-testid=requirement-mockups]");
  const properties = q("[data-testid=requirement-facts]");
  if (!group || !properties) return [...wrong, "the rail draws no properties or no mockups group"];
  if (group.getBoundingClientRect().top < properties.getBoundingClientRect().bottom - 1) wrong.push("the mockups are not under the properties");
  const listed = all("[data-testid=requirement-mockup]").map((r) => r.dataset.key);
  if (listed.join(",") !== "MK-2") wrong.push(`the rail lists ${listed.join(",")}, not the newest revision MK-2 alone`);
  if (!q("[data-testid=requirement-mockup-add]")) wrong.push("Add mockup is not drawn");
  group.scrollIntoView({ block: "center" });
  return [...wrong, ...sideways()];
}

async function fullScreen(): Promise<string[]> {
  q<HTMLButtonElement>("[data-testid=requirement-mockup]")?.click();
  const wrong = await until(() => q("[data-testid=mockup-html]") !== null, "the mockup's frame");
  const frame = q<HTMLIFrameElement>("[data-testid=mockup-html]");
  if (frame?.getAttribute("sandbox") !== "allow-scripts") wrong.push(`the frame's sandbox is "${frame?.getAttribute("sandbox")}"`);
  wrong.push(...(await until(() => ran.length > 0, "a sign that the mockup's scripts ran", 160)));
  if (!(await fixture)) wrong.push("no mockup-fixture.js beside the page: the frame runs an empty page");
  if (!q("[data-testid=mockup-ask]")) wrong.push("the viewer offers no chat about the mockup");
  if (!q("[data-testid=mockup-feedback-open]")) wrong.push("the viewer offers no feedback about the mockup");
  await settle(1500);
  return [...wrong, ...fillsTheWindow()];
}

async function pinned(): Promise<string[]> {
  q<HTMLButtonElement>("[data-testid=mockup-pin-toggle]")?.click();
  await settle(100);
  const layer = q("[data-testid=mockup-pin-layer][data-picking=true]");
  if (!layer) return ["pressing Pin did not make the frame take a press"];
  const r = layer.getBoundingClientRect();
  const at = { clientX: r.left + r.width * 0.62, clientY: r.top + r.height * 0.3, bubbles: true, pointerId: 1 };
  // a press and its release are two tasks, as a hand makes them: the press's update lands between
  layer.dispatchEvent(new PointerEvent("pointerdown", at));
  await settle(50);
  layer.dispatchEvent(new PointerEvent("pointerup", at));
  await settle(100);
  const draft = q("[data-testid=mockup-pin-draft]")?.textContent ?? "";
  if (!draft.startsWith("Point at")) return [`a press on the frame pinned nothing: the composer reads "${draft}"`];
  const box = q<HTMLTextAreaElement>("[data-testid=mockup-comment-form] textarea");
  if (!box) return ["the comment box is not drawn"];
  type(box, "Approve all should ask before it acts on twelve rows.");
  const send = all("[data-testid=mockup-comment-form] button").find((b) => b.textContent?.trim() === "Comment");
  send?.click();
  const wrong = await until(() => all("[data-testid=mockup-comment]").length === 3, "the new comment");
  const mark = all("[data-testid=mockup-pin]").find((m) => m.dataset.n === "3");
  if (!mark) return [...wrong, "the new comment has no mark on the frame"];
  const m = mark.getBoundingClientRect();
  const off = Math.hypot(m.left - (r.left + r.width * 0.62), m.top - (r.top + r.height * 0.3));
  if (off > 4) wrong.push(`the mark stands ${Math.round(off)} px from where it was pinned`);
  const row = all("[data-testid=mockup-comment]")[2]?.textContent ?? "";
  if (!row.includes("Point at 62% across, 30% down")) wrong.push(`the comment does not say where it points: "${row.slice(0, 80)}"`);
  return [...wrong, ...fillsTheWindow()];
}

async function revisions(): Promise<string[]> {
  const listed = all("[data-testid=mockup-revision]").map((r) => r.dataset.key);
  const wrong = listed.join(",") === "MK-1,MK-2" ? [] : [`the revisions read ${listed.join(",")}, not MK-1 then MK-2`];
  all("[data-testid=mockup-revision]")[0]?.click();
  wrong.push(...(await until(() => q("[data-testid=mockup-viewer]")?.dataset.key === "MK-1", "the earlier revision")));
  const viewer = q("[data-testid=mockup-viewer]")?.textContent ?? "";
  if (!viewer.includes("Comments go on its next revision, MK-2.")) wrong.push("the earlier revision does not say comments go on MK-2");
  const settled = all("[data-testid=mockup-comment-settled]").map((s) => s.textContent ?? "");
  if (!settled.some((s) => s.includes("Answered by MK-2"))) wrong.push(`no comment reads as answered by MK-2: ${settled.join(" | ")}`);
  await settle(800);
  return [...wrong, ...fillsTheWindow()];
}

async function dark(): Promise<string[]> {
  document.documentElement.dataset.theme = "dark";
  all("[data-testid=mockup-revision]")[1]?.click();
  const wrong = await until(() => q("[data-testid=mockup-viewer]")?.dataset.key === "MK-2", "the newest revision");
  await settle(1200);
  return [...wrong, ...fillsTheWindow()];
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => q("[data-testid=requirement-detail]") !== null,
  stages: [
    { name: "requirement", run: onTheRequirement },
    { name: "full-screen", run: fullScreen },
    { name: "pinned", run: pinned },
    { name: "revisions", run: revisions },
    { name: "dark", run: dark },
  ],
};
