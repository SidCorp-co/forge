// "Your feedback to Forge" (REQ-47 BC-3, BC-9), witnessed as drawn: the person's own reports about
// Forge from any project, flush rows with where each came from, how many times it was reported, and
// where it stands; a row opens on what its progress says and what its triage told them (BC-10). Read
// as laid out at desktop and phone width.
//
//   pnpm --filter web-v2 witness witness/my-forge-feedback.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { TopBarSlotProvider } from "@/design";
import { MyForgeFeedback } from "@/features/feedback";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { settle, sideways } from "./connect-flow.fixture";
import "./entry";
import { InRouter } from "./router";

const AT = "2026-10-20T08:00:00.000Z";
const origin = (project: string, occurrences: number) => ({
  occurrences,
  project: { id: `p-${project}`, slug: project.toLowerCase(), name: project },
  issue: null,
  run: null,
  clientVersion: "web 0.4.0-dev.260",
  reporter: { id: "u1", name: "Lan", agency: "human" },
  at: AT,
});
const progress = (says: string, running = false) => ({
  label: "forecast",
  asOf: AT,
  running,
  says,
  work: null,
  runs: [],
  waitingOn: [],
  eta: { estimate: false },
});
const NONE = { answer: null, declined: null, clarification: null, shippedIn: null };
const item = (key: string, title: string, phase: string, from: string, n: number, says: string, running = false, told = NONE) => ({
  key,
  title,
  kind: "bug",
  severity: "medium",
  phase,
  route: null,
  origin: origin(from, n),
  createdAt: AT,
  updatedAt: AT,
  progress: progress(says, running),
  shipEvidence: null,
  told,
});
const LIST = {
  feedback: [
    item("FB-212", "The board drops a card dragged to Done", "new", "HOP", 1, "Waiting to be triaged by Forge's team."),
    item("FB-198", "forge claim refuses a lease that has expired", "planned", "Autoflow", 4, "ISS-1433 carries it and a run is working on it now.", true),
    item("FB-160", "The release page cuts the version at phone width", "verified", "Catalog", 2, "Shipped in 0.4.0-dev.244 and verified.", false, {
      ...NONE,
      shippedIn: "0.4.0-dev.244",
    }),
  ],
  returned: 3,
  home: { id: "p-forge", slug: "forge-dev", name: "Forge" },
  asOf: AT,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  if (path === "/forge/feedback") return json(LIST);
  if (path === "/version") return json({ version: "0.4.0-dev.260", sourceCommit: null, uptimeSeconds: 60 });
  return new Promise<Response>(() => {});
};

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
  <InRouter at="/forge-feedback">
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TopBarSlotProvider>
        <ShellTopBar chatOpen={false} onToggleChat={() => {}} />
        <MyForgeFeedback />
      </TopBarSlotProvider>
    </QueryClientProvider>
  </InRouter>,
);

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-testid=my-forge-feedback-item]")];

function listed(): string[] {
  const wrong = sideways();
  if (rows().length !== 3) wrong.push(`${rows().length} rows are drawn, not 3`);
  const text = document.body.textContent ?? "";
  const title = document.querySelector("header h1")?.getBoundingClientRect().left;
  const key = rows()[0]?.querySelector(".font-mono")?.getBoundingClientRect().left;
  if (title === undefined || key === undefined || Math.abs(title - key) > 1) wrong.push(`the first key starts at x=${key}, not under the page title at x=${title}`);
  for (const said of ["Your feedback to Forge", "from HOP", "4 reports", "Work running"]) if (!text.includes(said)) wrong.push(`the page never says "${said}"`);
  return wrong;
}

async function opened(): Promise<string[]> {
  const second = rows()[1];
  (second?.querySelector("button") ?? second)?.click();
  await settle(250);
  const wrong = sideways();
  if (!document.body.textContent?.includes("ISS-1433 carries it")) wrong.push("an opened row does not say what its progress says");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => rows().length > 0,
  stages: [
    { name: "list", run: listed },
    { name: "opened", run: opened },
  ],
};
