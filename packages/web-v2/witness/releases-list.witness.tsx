// The Releases list in the approved report shape (ISS-1001), witnessed at phone and desktop width in
// both themes over adminhub-fe's releases: the draft 0.56.0 waiting on you with its one bar and act,
// the 51 landings on stg it carries folded into one line under it, the last three in production and
// the rest behind one row; no key or sha on the face, nothing cut or scrolling sideways. Its last stage
// reads forge-dev's line, whose versions wrapped at 420 on dev.515 ("0.4.0-" over "dev.515"): every
// version holds one line.
//
//   pnpm --filter web-v2 witness witness/releases-list.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ReleasesScreen } from "@/features/releases/components/releases-screen";
import { rawKeysOnFace } from "@/test/screen-face";
import "./entry";
import { LIST, P, SLUG } from "./releases-redesign.fixture";
import { InRouter } from "./router";

window.fetch = async () => new Promise<Response>(() => {});
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["releases", P], LIST);
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at={`/projects/${SLUG}/releases`} pattern="/projects/$slug/releases">
    <QueryClientProvider client={client}>
      <div className="min-h-screen bg-app">
        <ReleasesScreen projectId={P} slug={SLUG} />
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const settle = () => new Promise((r) => setTimeout(r, 150));
const rows = (group: string) => [...document.querySelectorAll(`[data-testid=release-group][data-group=${group}] [data-testid=list-row]`)].map((r) => r.getAttribute("data-key"));

function reads(): string[] {
  const wrong: string[] = [...versionsWhole()];
  if (rows("you").join() !== "0.56.0") wrong.push(`Waiting on you lists ${rows("you").join() || "nothing"}, not 0.56.0`);
  if (rows("production").join() !== "0.55.0,0.54.0,0.53.0") wrong.push(`In production shows ${rows("production").join()}, not the last three`);
  const carries = document.querySelector("[data-testid=release-carries]");
  if (carries?.getAttribute("data-n") !== "51") wrong.push(`0.56.0 carries ${carries?.getAttribute("data-n") ?? "no"} landings, not 51`);
  if (document.querySelector("[data-testid=list-row][data-state=landed]")) wrong.push("a landing is drawn as a row of its own");
  if (document.querySelectorAll("[data-testid=release-row-act]").length !== 1) wrong.push("the list offers other than one act");
  const keys = rawKeysOnFace(document.body);
  if (keys.length > 0) wrong.push(`raw keys on the face: ${keys.join("; ")}`);
  for (const bar of document.querySelectorAll("[data-testid=release-proof]")) {
    if (bar.getBoundingClientRect().right > window.innerWidth + 0.5) wrong.push("a proof bar runs past the window");
  }
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

/** forge-dev's line on dev.515: versions with a break in them, beside names long enough to squeeze them. */
const DEV_NAMES = ["Clearer Release Check Guidance for Approvers", "Clearer activity and release markers", "Clearer decisions"];
const DEV_LIST = {
  ...LIST,
  releases: LIST.releases.map((r, i) => ({ ...r, key: `0.4.0-dev.${515 - i}`, version: `0.4.0-dev.${515 - i}`, name: DEV_NAMES[i % 3] ?? null })),
};

/** How many lines a drawn element's text runs over: a flex item is one box, so its text's line boxes are counted. */
function linesOf(el: Element): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
}

/** Every version drawn on one line: a version broken across two reads as two things. */
function versionsWhole(): string[] {
  const versions = [...document.querySelectorAll("[data-testid=release-version]")];
  if (versions.length === 0) return ["no version is drawn"];
  return versions.flatMap((v) => (linesOf(v) > 1 ? [`${v.textContent} wraps over ${linesOf(v)} lines`] : []));
}

async function devLine(): Promise<string[]> {
  client.setQueryData(["releases", P], DEV_LIST);
  await settle();
  document.querySelector<HTMLButtonElement>("[data-testid=release-carries-toggle]")?.click();
  await settle();
  const sideways = document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : [];
  return [...versionsWhole(), ...sideways];
}

window.__witness = {
  cases: [
    { name: "phone", width: 420 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => document.querySelector("[data-testid=release-list]") !== null,
  stages: [
    { name: "light", run: async () => (theme("light"), await settle(), reads()) },
    { name: "dark", run: async () => (theme("dark"), await settle(), reads()) },
    { name: "dev-line", run: devLine },
  ],
};
