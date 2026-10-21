// The Approvals page witnessed as drawn (REQ-48 BC-11): the one Needs you list beside the project menu
// whose Approvals row carries the same count, grouped by topic, each row its subject, the agent's
// proposal and its tags, with ✓ / ✕ on the right. Then a feedback item's peek (what the agent proposes,
// if you approve, why, what the reporter said, and the footer that decides it), a design update's
// peek with the designs that move, a selection's bar stating what approving makes, a decline's
// reason step, and the Undo held after an approve. At 390 px the peek is its full-screen sheet and
// nothing scrolls sideways. The rows are `src/test/approvals-read.ts`, the read the page tests use.
//
//   pnpm --filter web-v2 witness witness/approvals.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { NavRail } from "@/design";
import { ApprovalsScreen } from "@/features/approvals";
import { projectMenu, workspaceNavItems } from "@/features/shell/nav-model";
import { APPROVALS_PROJECT as P, APPROVALS_READ as READ } from "@/test/approvals-read";
import "./entry";
import { InRouter } from "./router";

const PHONE = 600;

window.localStorage.clear();
window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes(`/projects/${P}/needs-you/decisions`)) return new Response(JSON.stringify(READ), { headers: { "content-type": "application/json" } });
  return new Promise<Response>(() => {});
};

const noop = () => {};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const phone = window.innerWidth < PHONE;

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/approvals" pattern="/projects/$slug/approvals">
    <QueryClientProvider client={client}>
      <div style={{ display: "flex", minHeight: "100vh" }} className="bg-app">
        {phone ? null : (
          <div style={{ height: "100vh", flex: "none", position: "sticky", top: 0 }} data-testid="witness-rail">
            <NavRail
              compact={false}
              workspaceItems={workspaceNavItems(0, undefined)}
              projectItems={projectMenu({ decisions: READ })}
              activeKey="proj-approvals"
              onNavigate={noop}
              groupOpen={{}}
              onToggleGroup={noop}
            />
          </div>
        )}
        <main style={{ flex: 1, minWidth: 0 }}>
          <ApprovalsScreen projectId={P} slug="hop" />
        </main>
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-testid=approval-row]")];
const rowOf = (key: string) => rows().find((r) => r.querySelector("[data-testid=approval-open] span span")?.textContent === key);
const peek = () => document.querySelector<HTMLElement>("[data-testid=approval-peek]");
const settle = () => new Promise((r) => setTimeout(r, 200));
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};

function sideways(): string[] {
  return document.documentElement.scrollWidth > window.innerWidth ? [`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`] : [];
}

function listed(): string[] {
  const wrong = sideways();
  if (rows().length !== READ.total) wrong.push(`${rows().length} rows are drawn, not ${READ.total}`);
  const count = document.querySelector("[data-testid=approvals-count]")?.textContent ?? "";
  if (!count.includes(`${READ.total} waiting on you`)) wrong.push(`the page's count reads "${count}"`);
  if (!phone) {
    const rail = document.querySelector("[data-testid=witness-rail]")?.textContent ?? "";
    if (!rail.includes(String(READ.total))) wrong.push(`the menu's Approvals row does not read ${READ.total}`);
  }
  for (const r of rows()) {
    for (const b of r.querySelectorAll("button")) if (b.getBoundingClientRect().right > window.innerWidth + 0.5) wrong.push(`a row's "${b.getAttribute("aria-label") ?? b.textContent}" runs past the window's right edge`);
  }
  return wrong;
}

function open(key: string): string[] {
  const button = rowOf(key)?.querySelector<HTMLElement>("[data-testid=approval-open]");
  if (!button) return [`no row ${key} to open`];
  button.click();
  return [];
}

function closePeek() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

function peekReads(...parts: string[]): string[] {
  const p = peek();
  if (!p) return ["no peek is open"];
  const wrong = sideways();
  for (const part of parts) if (!p.querySelector(`[data-testid=approval-peek-${part}]`)) wrong.push(`the peek draws no ${part}`);
  const foot = p.querySelector("[data-testid=approval-peek-foot]")?.getBoundingClientRect();
  if (!foot || foot.bottom > window.innerHeight + 0.5) wrong.push("the peek's footer is not in view");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => rows().length === READ.total,
  stages: [
    { name: "list-light", run: async () => (theme("light"), await settle(), listed()) },
    { name: "list-dark", run: async () => (theme("dark"), await settle(), listed()) },
    {
      name: "peek-feedback-light",
      run: async () => {
        theme("light");
        const wrong = open("FB-135");
        await settle();
        return [...wrong, ...peekReads("proposal", "consequences", "why", "said", "foot")];
      },
    },
    {
      name: "peek-design-update-dark",
      run: async () => {
        theme("dark");
        closePeek();
        await settle();
        const wrong = open("system-context");
        await settle();
        return [...wrong, ...peekReads("proposal", "consequences", "table", "foot")];
      },
    },
    {
      name: "decline-reason-light",
      run: async () => {
        theme("light");
        closePeek();
        await settle();
        rowOf("FB-139")?.querySelector<HTMLElement>("[data-testid=approval-decline]")?.click();
        await settle();
        peek()?.querySelector<HTMLElement>("[data-testid=approval-words-send]")?.click();
        await settle();
        const alert = peek()?.querySelector("[role=alert]")?.textContent ?? "";
        return alert.includes("A decline needs a reason") ? sideways() : ["an empty decline is not refused in place"];
      },
    },
    {
      name: "bulk-light",
      run: async () => {
        closePeek();
        await settle();
        document.querySelector<HTMLElement>("[data-testid=approval-group-feedback] [role=checkbox]")?.click();
        await settle();
        const summary = document.querySelector("[data-testid=approval-bulk-summary]")?.textContent ?? "";
        const want = "Approving makes 2 new issues · 1 requirement revision · 1 closed · 2 marked Check first";
        return summary.includes(want) ? sideways() : [`the bulk bar reads "${summary}", not "${want}"`];
      },
    },
    {
      name: "after-approve-light",
      run: async () => {
        document.querySelector<HTMLElement>("[data-testid=approval-bulk-clear]")?.click();
        await settle();
        const wrong = open("requirement-to-delivery");
        await settle();
        peek()?.querySelector<HTMLElement>("[data-testid=approval-peek-approve]")?.click();
        await settle();
        const undo = document.querySelector("[data-testid=approval-undo]")?.textContent ?? "";
        if (!undo.includes("requirement-to-delivery approved")) wrong.push(`the Undo bar reads "${undo}"`);
        return [...wrong, ...peekReads("proposal", "foot")];
      },
    },
  ],
};
