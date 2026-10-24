// Where a merge-request release stands, witnessed at phone and desktop width in both themes (REQ-71
// BC-6): its owner deploys, so it ends at merge and asks for no production; once accepted it says
// the agent merges it. Planted from adminhub-api 0.1.0 (af0be6bc), which read "Add a production
// environment, then approve".
//
//   pnpm --filter web-v2 witness witness/release-owner-deploys.witness.tsx --out <dir>

import { createRoot } from "react-dom/client";
import { WhereReleaseStands } from "@/features/releases/components/release-rail";
import type { ReleaseDetail } from "@/features/releases/types";
import "./entry";
import { InRouter } from "./router";

const release = (state: "awaiting_approval" | "in_progress") =>
  ({
    state,
    releasedAt: null,
    approval: null,
    approvalRequired: true,
    production: null,
    ownerDeploys: true,
    verified: { level: "none", proven: 0, total: 6, check: null, provider: null },
  }) as unknown as ReleaseDetail;

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter>
    <div className="min-h-screen bg-app p-4">
      <div className="mx-auto grid max-w-sm gap-8">
        <div data-testid="awaiting">
          <WhereReleaseStands r={release("awaiting_approval")} />
        </div>
        <div data-testid="accepted">
          <WhereReleaseStands r={release("in_progress")} />
        </div>
      </div>
    </div>
  </InRouter>,
);

const text = (id: string, field: string) =>
  document.querySelector(`[data-testid=${id}] [data-testid=${field}]`)?.textContent ?? "";
const settle = () => new Promise((r) => setTimeout(r, 100));

function reads(): string[] {
  const wrong: string[] = [];
  if (!text("awaiting", "standing-goes-to").includes("Ends at merge")) wrong.push(`goes to reads "${text("awaiting", "standing-goes-to")}"`);
  if (document.body.textContent?.includes("production environment")) wrong.push("the standing asks for a production environment");
  if (!text("awaiting", "standing-next").includes("Approve the release")) wrong.push(`next before accept reads "${text("awaiting", "standing-next")}"`);
  if (!text("accepted", "standing-next").includes("the agent merges it")) wrong.push(`next after accept reads "${text("accepted", "standing-next")}"`);
  if (!text("accepted", "standing-status").endsWith("Accepted, merging")) wrong.push(`status after accept reads "${text("accepted", "standing-status")}"`);
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => document.querySelectorAll("[data-testid=release-standing]").length === 2,
  stages: [
    { name: "light", run: async () => (theme("light"), await settle(), reads()) },
    { name: "dark", run: async () => (theme("dark"), await settle(), reads()) },
  ],
};
