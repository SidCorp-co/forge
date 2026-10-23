// A release that ships by merging change requests, witnessed at phone and desktop width (REQ-63
// BC-5): its merges in order, each request's link, state and the issues it delivers, on one flat
// hairline list, with nothing cut or scrolling sideways at 390 px.
//
//   pnpm --filter web-v2 witness witness/release-merges.witness.tsx --out <dir>

import { createRoot } from "react-dom/client";
import { ReleaseMerges } from "@/features/releases/components/release-merges";
import "./entry";
import { InRouter } from "./router";

const mr = (number: number, order: number, state: "open" | "merged", title: string) => ({
  label: `!${number}`,
  number,
  title,
  url: `https://gitlab.com/sidcorp-it/canawan-api/-/merge_requests/${number}`,
  state,
  order,
});
const STACK = [
  ["ISS-1", mr(5008, 1, "merged", "REQ-2/REQ-3: local db, site version")],
  ["ISS-4", mr(5008, 1, "merged", "REQ-2/REQ-3: local db, site version")],
  ["ISS-5", mr(5008, 1, "merged", "REQ-2/REQ-3: local db, site version")],
  ["ISS-10", mr(5009, 2, "open", "REQ-1: OpenAPI contract for every route")],
  ["ISS-13", mr(5009, 2, "open", "REQ-1: OpenAPI contract for every route")],
  ["ISS-14", mr(5010, 3, "open", "REQ-1/REQ-4: OpenAPI service tokens")],
  ["ISS-22", mr(5013, 4, "open", "REQ-4: Dodgeprint token")],
] as const;
const issues = STACK.map(([key, changeRequest]) => ({ key, changeRequest }));

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter>
    <div className="min-h-screen bg-app">
      <div className="mx-auto max-w-5xl">
        <ReleaseMerges issues={issues} slug="adminhub-api" />
      </div>
    </div>
  </InRouter>,
);

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-testid=release-merge]")];
const settle = () => new Promise((r) => setTimeout(r, 100));

function reads(): string[] {
  const wrong: string[] = [];
  const order = rows().map((r) => r.querySelector("a")?.textContent ?? "");
  if (order.join(",") !== "!5008,!5009,!5010,!5013") wrong.push(`the merges read ${order.join(",")}, not in their order`);
  if (rows()[0]?.dataset.state !== "merged") wrong.push("!5008 does not read merged");
  if ((rows()[0]?.textContent ?? "").indexOf("ISS-5") < 0) wrong.push("!5008 does not name ISS-5");
  for (const r of rows()) if (r.getBoundingClientRect().right > window.innerWidth + 0.5) wrong.push("a merge row runs past the window");
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => rows().length === 4,
  stages: [
    { name: "light", run: async () => (theme("light"), await settle(), reads()) },
    { name: "dark", run: async () => (theme("dark"), await settle(), reads()) },
  ],
};
