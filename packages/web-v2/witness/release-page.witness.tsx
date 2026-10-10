// A release page's "What this release proves" witnessed at phone and desktop width (REQ-40 BC-5,
// ISS-492): seven criteria of one issue proving one requirement criterion are drawn as seven rows a
// reader tells apart, under that criterion said once, and the requirement is counted in its own
// criteria. J7 on 0.4.0-dev.222 saw the same sentence drawn seven times. The developer view's notes
// then open, so a clip of the run shows both.
//
//   pnpm --filter web-v2 witness witness/release-page.witness.tsx --out <dir> --clip

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ReleaseReader } from "@/features/releases/components/release-reader";
import { releasePage, TECHNICAL } from "@/test/release-page";
import "./entry";

const BC18 = "A refusal says in plain words what to fix, on that field.";
const SEVEN = [
  "A title left empty is refused on the title field.",
  "A due date in the past is refused on the date field.",
  "An unknown assignee is refused on the assignee field.",
  "A label over 40 characters is refused on the label field.",
  "A duplicate key is refused on the key field.",
  "A priority outside the list is refused on the priority field.",
  "An estimate below zero is refused on the estimate field.",
];

const page = releasePage({
  view: "developer",
  highlights: { state: "none", why: "nothing on this build is claimed yet" },
  requirements: [
    {
      key: "REQ-34",
      title: "Every refusal names the field and the fix",
      completes: false,
      proven: SEVEN.map((statement, i) => ({ code: "BC-18", statement, short: i === 6, issueKey: "ISS-451", n: i + 2 })),
      unproven: 30,
      business: { total: 26, proven: [{ code: "BC-18", statement: BC18 }] },
    },
  ],
  technical: TECHNICAL,
});

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <div className="mx-auto max-w-3xl p-4">
      <ReleaseReader page={page} authed={false} />
    </div>
  </QueryClientProvider>,
);

const req = () => document.querySelector("[data-testid=page-requirement]");

function proves(): string[] {
  const r = req();
  if (!r) return ["no requirement is drawn"];
  const wrong: string[] = [];
  const rows = [...r.querySelectorAll("[data-testid=page-proven-row]")].map((e) => (e.textContent ?? "").trim());
  if (rows.length !== 7) wrong.push(`REQ-34 draws ${rows.length} rows, not 7`);
  if (new Set(rows).size !== rows.length) wrong.push(`REQ-34 draws ${rows.length} rows and only ${new Set(rows).size} read apart`);
  const said = (r.textContent ?? "").split(BC18).length - 1;
  if (said !== 1) wrong.push(`BC-18's wording is drawn ${said} times, not once`);
  const count = r.querySelector("[data-testid=page-requirement-count]")?.textContent ?? "";
  if (count !== "1 of its 26 criteria proven on this build") wrong.push(`the requirement's count reads "${count}"`);
  for (const row of r.querySelectorAll("[data-testid=page-proven-row]")) {
    if (row.getBoundingClientRect().right > window.innerWidth) wrong.push(`a row runs past the window: ${(row.textContent ?? "").slice(0, 40)}`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

async function opensChanges(): Promise<string[]> {
  const toggle = document.querySelector<HTMLButtonElement>("[data-testid=release-technical-toggle]");
  if (!toggle) return ["the developer view draws no What it changes toggle"];
  toggle.scrollIntoView({ block: "center" });
  toggle.click();
  await new Promise((ok) => setTimeout(ok, 50));
  return toggle.getAttribute("aria-expanded") === "true" ? [] : ["What it changes did not open"];
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1280 },
  ],
  ready: () => req() !== null,
  stages: [
    { name: "proves", run: proves },
    { name: "changes", run: opensChanges },
  ],
};
