// A project's Boxes page (ISS-1276 c7, mockup MK-12) witnessed as drawn, at desktop width and on a
// phone (390×844): the overview, the boxes and the waiting queue, and the box a person holds selected,
// its live view, who holds it and since when, the idle countdown, the command feed with the agent's act
// refused while they hold it, and the footer saying it records and why, with the toggle that stops it
// (ISS-1321), in light and dark, then stopped. The records are `src/test/boxes.ts`, the ones the page's
// tests use; core and the view socket are stood in for, and the view's one frame is drawn here, so the
// screenshot shows the page, never a box. Each case logs its first view's word count.
//
//   pnpm --filter web-v2 witness witness/boxes-page.witness.tsx --out <dir>

import { BOX_ROUTES } from "@forge/contracts/boxes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { NavRail, TopBarSlotProvider } from "@/design";
import { BoxesScreen } from "@/features/boxes";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { buildActiveKey, projectMenu, workspaceNavItems } from "@/features/shell/nav-model";
import { androidActs, androidSpans, BOX, heldActs, ISSUE_LABELS, PROJECT_ID, projectBoxes } from "@/test/boxes";
import "./entry";
import { firstScreenWords } from "./first-screen";
import { InRouter } from "./router";

const PHONE = 600;
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const route = (r: string, id: string) => r.replace(":id", id).replace(/^\/api/, "");

/** Whether the held box still records: the toggle's POST stops it, and the list reads it back. */
let recording = true;
const boxesNow = () =>
  projectBoxes().map((b) => (b.id === BOX.held && !recording ? { ...b, recording: b.recording && { ...b.recording, state: "kept" as const, why: null } } : b));

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://forge.invalid").pathname.replace(/^.*?\/api/, "");
  if (init?.method === "POST" && path === route(BOX_ROUTES.recording, BOX.held)) {
    recording = (JSON.parse(String(init.body)) as { on: boolean }).on;
    return json({ box: boxesNow().find((b) => b.id === BOX.held) });
  }
  if (path === route(BOX_ROUTES.ofProject, PROJECT_ID)) return json({ boxes: boxesNow() });
  const issue = /^\/issues\/([^/]+)$/.exec(path)?.[1];
  if (issue && ISSUE_LABELS[issue]) return json(ISSUE_LABELS[issue]);
  if (path === route(BOX_ROUTES.acts, BOX.held)) return json({ acts: heldActs() });
  if (path === route(BOX_ROUTES.acts, BOX.android)) return json({ acts: androidActs() });
  if (path === route(BOX_ROUTES.spans, BOX.held)) return json({ spans: androidSpans().map((s) => ({ ...s, boxId: BOX.held })) });
  if (path.endsWith("/acts")) return json({ acts: [] });
  if (path.endsWith("/spans")) return json({ spans: [] });
  if (path.endsWith("/ticket")) return json({ ticket: "t", expiresAt: new Date(Date.now() + 60_000).toISOString(), url: "/ws/boxes/view?ticket=t" });
  return new Promise<Response>(() => {});
};

/** The one frame the stood-in view sends: a guest web page at 390×844, drawn here. */
function fixtureFrame(): string {
  const c = document.createElement("canvas");
  c.width = 390;
  c.height = 844;
  const g = c.getContext("2d");
  if (!g) return "";
  g.fillStyle = "#f4f1ea";
  g.fillRect(0, 0, 390, 844);
  g.fillStyle = "#1f6f5c";
  g.fillRect(0, 0, 390, 64);
  g.fillStyle = "#ffffff";
  g.font = "600 20px sans-serif";
  g.fillText("Table 7 · Menu", 20, 40);
  g.fillStyle = "#d9d4c7";
  for (let i = 0; i < 6; i++) g.fillRect(20, 96 + i * 104, 350, 84);
  g.fillStyle = "#1f6f5c";
  g.fillRect(20, 740, 350, 56);
  return c.toDataURL("image/jpeg", 0.8).split(",")[1] ?? "";
}

class StoodInSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  onmessage: null | ((e: { data: string }) => void) = null;
  onclose: null | ((e: { code: number; reason: string }) => void) = null;
  onopen: null | (() => void) = null;
  constructor(readonly url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      const hello = { type: "hello", boxId: BOX.held, codec: "jpeg-frames", width: 390, height: 844, fps: 10, holder: "person:x", watchOnly: true };
      this.onmessage?.({ data: JSON.stringify(hello) });
      this.onmessage?.({ data: JSON.stringify({ type: "frame", seq: 1, data: fixtureFrame(), metadata: {} }) });
    }, 50);
  }
  send() {}
  close() {}
}
window.WebSocket = StoodInSocket as unknown as typeof WebSocket;
window.history.replaceState(null, "", `${window.location.pathname}?box=${BOX.held}`);

const noop = () => {};
const phone = window.innerWidth < PHONE;
const at = "/projects/orvio/boxes";

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at={at} pattern="/projects/$slug/boxes">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TopBarSlotProvider>
        <div style={{ display: "flex", minHeight: "100vh" }} className="bg-app">
          {phone ? null : (
            <div style={{ height: "100vh", flex: "none", position: "sticky", top: 0 }}>
              <NavRail compact={false} workspaceItems={workspaceNavItems(0, undefined)} projectItems={projectMenu({})} activeKey={buildActiveKey(at, "orvio")} onNavigate={noop} groupOpen={{ delivery: true }} onChooseGroups={noop} />
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <ShellTopBar chatOpen={false} onToggleChat={noop} />
            <main style={{ flex: 1, minWidth: 0 }} data-testid="witness-page">
              <BoxesScreen projectId={PROJECT_ID} canWrite />
            </main>
          </div>
        </div>
      </TopBarSlotProvider>
    </QueryClientProvider>
  </InRouter>,
);

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const settle = () => new Promise((r) => setTimeout(r, 400));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);

/** What the page owes at every stage: its parts drawn, nothing sideways, the live view inside the window. */
function drawn(): string[] {
  const wrong: string[] = [];
  const page = q("[data-testid=witness-page]");
  if (page) {
    const first = firstScreenWords(page);
    const whole = firstScreenWords(page, { whole: true });
    console.log(`${window.innerWidth}px: ${first.count} words on the first view, ${whole.count} on the whole page: ${first.words.join(" ")}`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  for (const id of ["boxes-band", "box-list", "box-queue", "box-live", "box-held-by", "box-idle", "box-foot", "box-recording", "box-open-record"]) if (!q(`[data-testid=${id}]`)) wrong.push(`no ${id} drawn`);
  if (!document.body.textContent?.includes("Open a box to test by hand")) wrong.push("no Open a box to test by hand");
  if (!q("[data-testid=box-feed-line][data-state=refused]")) wrong.push("the feed shows no refused act");
  const view = q("[data-testid=box-view] img")?.getBoundingClientRect();
  if (!view || view.width < 150) wrong.push(`the live view is ${Math.round(view?.width ?? 0)} px wide`);
  else if (view.right > window.innerWidth + 0.5) wrong.push(`the live view runs past the window: ${Math.round(view.right)} in ${window.innerWidth}`);
  return wrong;
}

/** The foot says whether the box records and why, and the toggle offers the move that changes it. */
function says(on: boolean): string[] {
  const wrong: string[] = [];
  const said = q("[data-testid=box-recording]")?.textContent ?? "";
  if (on && !/^● Recording · \d+:\d{2} · Turned on$/.test(said)) wrong.push(`the foot says "${said}", not that a person turned recording on`);
  if (!on && said !== "Not recording") wrong.push(`the foot says "${said}", not Not recording`);
  if (!button(on ? "Stop recording" : "Record")) wrong.push(`no ${on ? "Stop recording" : "Record"} toggle`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390, height: 844 },
  ],
  ready: () => !!q("[data-testid=box-queue]") && !!q("[data-testid=box-feed-line]") && q("[data-testid=box-view]")?.dataset.phase === "live" && !!q("[data-testid=box-view] img")?.getAttribute("src"),
  stages: [
    { name: "light", run: async () => (theme("light"), await settle(), [...drawn(), ...says(true)]) },
    { name: "dark", run: async () => (theme("dark"), await settle(), [...drawn(), ...says(true)]) },
    {
      name: "stopped",
      run: async () => {
        theme("light");
        button("Stop recording")?.click();
        for (let i = 0; i < 30 && q("[data-testid=box-recording]")?.dataset.on !== "false"; i++) await settle();
        return [...drawn(), ...says(false)];
      },
    },
  ],
};
