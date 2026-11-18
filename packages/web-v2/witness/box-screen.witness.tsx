// A box's screen alone (ISS-1325) witnessed as drawn, at desktop width and on a phone (390×844), light
// and dark: the Boxes page with its Full screen control, the box in full screen (headless Chrome grants
// no full screen to a scripted press, so this is the fallback that fills the viewport), the box's own
// address with an android box upright, a closed box playing its clip, and a box the reader may not
// see refused by name. The records are `src/test/boxes.ts`; core and the view socket are stood in for,
// and each view's one frame is drawn here, so the shots show the screens, never a box. Each stage logs
// its words on the first view; the page stage logs them with and without the Full screen control.
//
//   pnpm --filter web-v2 witness witness/box-screen.witness.tsx --out <dir>

import { BOX_ROUTES, type BoxRecord, type BoxSpanRecord } from "@forge/contracts/boxes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BoxAlone, BoxesScreen } from "@/features/boxes";
import { AuthProvider } from "@/providers/auth-provider";
import { BOX, ISSUE, ISSUE_LABELS, ME, PROJECT_ID, projectBoxes } from "@/test/boxes";
import "./entry";
import { firstScreenWords } from "./first-screen";
import { InRouter } from "./router";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const route = (r: string, id: string) => r.replace(":id", id).replace(/^\/api/, "");
const MISSING = "b0c09999-0000-4000-8000-000000000099";

/** The project's boxes, the held one this reader's own; the android box shows its screen as frames here. */
const boxes: BoxRecord[] = projectBoxes(Date.now(), true).map((b) => (b.id === BOX.android ? { ...b, view: { codec: "jpeg-frames", width: 1080, height: 2400 } } : b));
const doneSpans: BoxSpanRecord[] = [1, 2].map((n) => ({
  id: `5a${n}00000-0000-4000-8000-000000000021`,
  boxId: BOX.done,
  issueId: ISSUE.login,
  criterion: n,
  state: "attached",
  startedAt: new Date(Date.now() - 3_000_000).toISOString(),
  endedAt: new Date(Date.now() - 2_900_000).toISOString(),
  clipAttachmentId: `c11p0000-0000-4000-8000-00000000003${n}`,
  stillAttachmentId: null,
  detail: null,
}));

/** A screen as the stood-in view draws it: a guest web page, sized to the box. */
function frameCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d");
  if (!g) return c;
  const u = width / 390;
  g.fillStyle = "#f4f1ea";
  g.fillRect(0, 0, width, height);
  g.fillStyle = "#1f6f5c";
  g.fillRect(0, 0, width, 64 * u);
  g.fillStyle = "#ffffff";
  g.font = `600 ${20 * u}px sans-serif`;
  g.fillText("Table 7 · Menu", 20 * u, 40 * u);
  g.fillStyle = "#d9d4c7";
  for (let i = 0; i < Math.floor((height / u - 200) / 104); i++) g.fillRect(20 * u, (96 + i * 104) * u, width - 40 * u, 84 * u);
  g.fillStyle = "#1f6f5c";
  g.fillRect(20 * u, height - 104 * u, width - 40 * u, 56 * u);
  return c;
}

/** A clip as a span keeps one: half a second of the frame, recorded by Chrome itself. */
const clip: Promise<Blob> = new Promise((done) => {
  const c = frameCanvas(390, 844);
  const rec = new MediaRecorder(c.captureStream(10), { mimeType: "video/webm" });
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => parts.push(e.data);
  rec.onstop = () => done(new Blob(parts, { type: "video/webm" }));
  rec.start();
  const tick = setInterval(() => c.getContext("2d")?.fillRect(0, 0, 1, 1), 100);
  setTimeout(() => {
    clearInterval(tick);
    rec.stop();
  }, 500);
});

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://forge.invalid").pathname.replace(/^.*?\/api/, "");
  if (path === "/auth/me") return json({ id: ME, email: "me@orvio.test", name: "Me" });
  if (path === route(BOX_ROUTES.ofProject, PROJECT_ID)) return json({ boxes });
  if (path === route(BOX_ROUTES.get, MISSING)) return json({ error: { code: "NOT_FOUND", message: "box not found" } }, 404);
  const one = boxes.find((b) => path === route(BOX_ROUTES.get, b.id));
  if (one) return json({ box: one });
  const issue = /^\/issues\/([^/]+)$/.exec(path)?.[1];
  if (issue && ISSUE_LABELS[issue]) return json(ISSUE_LABELS[issue]);
  if (path.endsWith("/acts")) return json({ acts: [] });
  if (path === route(BOX_ROUTES.spans, BOX.done)) return json({ spans: doneSpans });
  if (path.endsWith("/spans")) return json({ spans: [] });
  if (path.startsWith("/attachments/")) return new Response(await clip, { headers: { "content-type": "video/webm" } });
  const ticket = /^\/boxes\/([^/]+)\/ticket$/.exec(path)?.[1];
  if (ticket && init?.method === "POST") {
    const channel = (JSON.parse(String(init.body)) as { channel: string }).channel;
    return json({ ticket, expiresAt: new Date(Date.now() + 60_000).toISOString(), url: `/ws/boxes/${channel}?ticket=${ticket}` });
  }
  return new Promise<Response>(() => {});
};

/** The view socket: hello at the box's own size, then one frame of it. */
class StoodInSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  onmessage: null | ((e: { data: string }) => void) = null;
  onclose: null | ((e: { code: number; reason: string }) => void) = null;
  onopen: null | (() => void) = null;
  constructor(readonly url: string) {
    const box = boxes.find((b) => url.includes(b.id));
    const size = box?.view ?? { width: 390, height: 844 };
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      if (!url.includes("/ws/boxes/view")) return;
      const hello = { type: "hello", boxId: box?.id, codec: "jpeg-frames", width: size.width, height: size.height, fps: 10, holder: "agent:run-qa", watchOnly: true };
      this.onmessage?.({ data: JSON.stringify(hello) });
      const data = frameCanvas(size.width, size.height).toDataURL("image/jpeg", 0.8).split(",")[1] ?? "";
      this.onmessage?.({ data: JSON.stringify({ type: "frame", seq: 1, data, metadata: {} }) });
    }, 50);
  }
  send() {}
  close() {}
}
window.WebSocket = StoodInSocket as unknown as typeof WebSocket;
window.history.replaceState(null, "", `${window.location.pathname}?box=${BOX.held}`);

type Show = { at: "page" } | { at: "alone"; boxId: string };
let show: (s: Show) => void = () => undefined;

function Shown() {
  const [now, setNow] = useState<Show>({ at: "page" });
  show = setNow;
  if (now.at === "page") return <BoxesScreen projectId={PROJECT_ID} canWrite />;
  return <BoxAlone key={now.boxId} boxId={now.boxId} slug="orvio" canWriteIn={() => true} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at={`/projects/orvio/boxes?box=${BOX.held}`} pattern="/projects/$slug/boxes">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthProvider>
        <main className="min-h-screen bg-app" data-testid="witness-page">
          <Shown />
        </main>
      </AuthProvider>
    </QueryClientProvider>
  </InRouter>,
);

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const settle = () => new Promise((r) => setTimeout(r, 400));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 40 && !ok(); i++) await settle();
};
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

function words(where: string, el: HTMLElement | null) {
  if (!el) return;
  const first = firstScreenWords(el);
  console.log(`${window.innerWidth}px ${where}: ${first.count} words on the first view: ${first.words.join(" ")}`);
  return first.count;
}

/** Nothing runs sideways, and the screen, where live, lies whole inside the window in the box's own shape. */
function fits(): string[] {
  const wrong: string[] = [];
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  const img = q("[data-testid=box-screen] [data-testid=box-view] img");
  if (!img) return wrong;
  const r = img.getBoundingClientRect();
  if (r.left < -0.5 || r.top < -0.5 || r.right > window.innerWidth + 0.5 || r.bottom > window.innerHeight + 0.5) wrong.push(`the screen runs past the window: ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)}`);
  const view = img.parentElement?.style.aspectRatio ?? "";
  const [w, h] = view.split("/").map((n) => Number(n.trim()));
  if (w && h && Math.abs(r.width / r.height - w / h) > 0.02) wrong.push(`the screen is ${Math.round(r.width)}×${Math.round(r.height)}, not the box's ${w}:${h}`);
  if (r.width < 150 && r.height < 300) wrong.push(`the screen is drawn ${Math.round(r.width)}×${Math.round(r.height)}`);
  return wrong;
}

const shownLive = () => q("[data-testid=box-screen] [data-testid=box-view]")?.dataset.phase === "live" && !!q("[data-testid=box-screen] [data-testid=box-view] img")?.getAttribute("src");

async function alone(boxId: string, ready: () => boolean) {
  q("[data-testid=box-screen-exit]")?.click();
  await settle();
  show({ at: "alone", boxId });
  await until(ready);
}

const both = (name: string, run: () => Promise<string[]>) => [
  { name: `${name}-light`, run: async () => (theme("light"), await run()) },
  { name: `${name}-dark`, run: async () => (theme("dark"), await settle(), fits()) },
];

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390, height: 844 },
  ],
  ready: () => !!q("[data-testid=box-full]") && q("[data-testid=box-live] [data-testid=box-view]")?.dataset.phase === "live",
  stages: [
    ...both("page", async () => {
      await settle();
      const page = q("[data-testid=witness-page]");
      const withControl = words("Boxes page", page);
      const control = q("[data-testid=box-full]");
      if (control) control.style.display = "none";
      const without = words("Boxes page without the Full screen control", page);
      if (control) control.style.display = "";
      return withControl === without ? fits() : [...fits(), `the Full screen control adds ${String((withControl ?? 0) - (without ?? 0))} words`];
    }),
    ...both("full", async () => {
      if (!q("[data-testid=box-screen]")) q("[data-testid=box-full]")?.click();
      await until(shownLive);
      words("full screen", q("[data-testid=box-screen]"));
      const mode = q("[data-testid=box-screen]")?.dataset.mode;
      return mode ? fits() : ["no full screen drawn"];
    }),
    ...both("alone", async () => {
      if (!q("[data-testid=box-screen]")?.textContent?.includes("ISS-12")) await alone(BOX.android, shownLive);
      words("the box's own address", q("[data-testid=box-screen]"));
      return shownLive() ? fits() : ["the android box's screen is not live at its address"];
    }),
    ...both("closed", async () => {
      if (!q("[data-testid=box-ended]")) await alone(BOX.done, () => !!q("[data-testid=box-clip]"));
      words("a closed box", q("[data-testid=box-screen]"));
      return q("[data-testid=box-clip]") ? fits() : ["the closed box plays no clip"];
    }),
    ...both("refused", async () => {
      if (!q("[data-testid=box-alone-refused]")) await alone(MISSING, () => !!q("[data-testid=box-alone-refusal]"));
      words("a refused box", q("[data-testid=witness-page]"));
      return q("[data-testid=box-alone-refusal]")?.textContent?.includes("NOT_FOUND") ? fits() : ["the refusal names no code"];
    }),
  ],
};
