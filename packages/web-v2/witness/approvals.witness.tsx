// The Approvals page witnessed as drawn (REQ-48 BC-11): the one Needs you list beside the project menu
// whose Approvals row carries the same count, grouped by topic, each row its subject, the agent's
// proposal and its tags, with ✓ / ✕ on the right. Then a feedback item's peek (what the agent proposes,
// if you approve, why, what the reporter said, and the footer that decides it), a design update's
// peek with the designs that move, a selection's bar stating what approving makes, a decline's
// reason step, and the Undo held after an approve. A question's ✓ names the answer it sends, and its
// other answers open its peek; a release's ✕ asks why and is never its approve (ISS-539). At 390 px the peek is its full-screen sheet and
// nothing scrolls sideways. The rows are `src/test/approvals-read.ts`, the read the page tests use.
// Three decisions show at a time, the rest counted (REQ-68 BC-3), so a stage reaches a row past them
// by the page's own search; every peek says what deciding changes and its impact (REQ-68 BC-1).
// A mockup decision (REQ-49 BC-7) shows its page small in its row and runs it in its peek: the page is
// `<out>/mockup-fixture.js` where one is written there (`mockups-on-the-item.witness.tsx` says how),
// else a line of HTML.
//
//   pnpm --filter web-v2 witness witness/approvals.witness.tsx --out <dir>

import { NEEDS_YOU_PERSON_CAP } from "@forge/contracts/steward";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { NavRail, TopBarSlotProvider } from "@/design";
import { ApprovalsScreen } from "@/features/approvals";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { projectMenu, workspaceNavItems } from "@/features/shell/nav-model";
import { APPROVALS_PROJECT as P, APPROVALS_READ as READ } from "@/test/approvals-read";
import "./entry";
import { InRouter } from "./router";

const PHONE = 600;

declare global {
  interface Window {
    __mockupHtml?: string;
  }
}

const mockupPage = new Promise<string>((ok) => {
  const s = document.createElement("script");
  s.src = "mockup-fixture.js";
  s.onload = () => ok(window.__mockupHtml ?? "");
  s.onerror = () => ok("<!doctype html><body style='font:16px sans-serif;padding:24px'><h1>Approvals page</h1><button>Approve all</button></body>");
  document.head.append(s);
});

window.localStorage.clear();
window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/mockups/MK-4/content")) return new Response(await mockupPage, { headers: { "content-type": "text/html" } });
  if (url.includes(`/projects/${P}/needs-you/decisions`)) return new Response(JSON.stringify(READ), { headers: { "content-type": "application/json" } });
  return new Promise<Response>(() => {});
};

const noop = () => {};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const phone = window.innerWidth < PHONE;

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/approvals" pattern="/projects/$slug/approvals">
    <QueryClientProvider client={client}>
      <TopBarSlotProvider>
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
        {/* the page names itself into the shell's bar, gutter and all, as the product draws it */}
        <div className="flex min-w-0 flex-1 flex-col">
          <ShellTopBar chatOpen={false} onToggleChat={noop} />
          <main style={{ flex: 1, minWidth: 0 }}>
            <ApprovalsScreen projectId={P} slug="hop" />
          </main>
        </div>
      </div>
      </TopBarSlotProvider>
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
  if (rows().length !== NEEDS_YOU_PERSON_CAP) wrong.push(`${rows().length} rows are drawn, not ${NEEDS_YOU_PERSON_CAP}`);
  const more = document.querySelector("[data-testid=approvals-cap-more]")?.textContent ?? "";
  if (!more.startsWith(`${READ.total - NEEDS_YOU_PERSON_CAP} more after these`)) wrong.push(`the rest are counted as "${more}"`);
  const count = document.querySelector("[data-testid=approvals-count]")?.textContent ?? "";
  if (!count.includes(`Decisions waiting on you: ${READ.total}`)) wrong.push(`the page's count reads "${count}"`);
  const h1 = document.querySelector<HTMLElement>("header h1");
  if (!h1 || h1.scrollWidth > h1.clientWidth + 0.5) wrong.push(`the page title is cut to ${h1?.clientWidth ?? 0} px of its ${h1?.scrollWidth ?? 0}`);
  if (!phone) {
    const rail = document.querySelector("[data-testid=witness-rail]")?.textContent ?? "";
    if (!rail.includes(String(READ.total))) wrong.push(`the menu's Approvals row does not read ${READ.total}`);
  }
  for (const r of rows()) {
    for (const b of r.querySelectorAll("button")) if (b.getBoundingClientRect().right > window.innerWidth + 0.5) wrong.push(`a row's "${b.getAttribute("aria-label") ?? b.textContent}" runs past the window's right edge`);
  }
  return wrong;
}

/** Type into the page's search, as a person narrows the list to reach a row past the first three. */
async function search(text: string) {
  const box = document.querySelector<HTMLInputElement>("input[type=search]");
  if (!box) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
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
  ready: () => rows().length === NEEDS_YOU_PERSON_CAP,
  stages: [
    { name: "list-light", run: async () => (theme("light"), await settle(), listed()) },
    { name: "list-dark", run: async () => (theme("dark"), await settle(), listed()) },
    {
      name: "peek-feedback-light",
      run: async () => {
        theme("light");
        const wrong = open("FB-135");
        await settle();
        return [...wrong, ...peekReads("proposal", "stakes", "consequences", "why", "said", "foot")];
      },
    },
    {
      name: "peek-design-update-dark",
      run: async () => {
        theme("dark");
        closePeek();
        await search("system-context");
        const wrong = open("system-context");
        await settle();
        return [...wrong, ...peekReads("proposal", "consequences", "table", "foot")];
      },
    },
    {
      name: "peek-mockup-light",
      run: async () => {
        theme("light");
        closePeek();
        await search("REQ-49");
        const row = rows().find((r) => r.dataset.topic === "mockup");
        const wrong: string[] = [];
        if (!phone && !row?.querySelector("[data-testid=approval-row-mockup] iframe[sandbox=allow-scripts]")) wrong.push("the mockup row draws no isolated preview");
        if (!row?.querySelector("[data-testid=approval-mockup-standing]")?.textContent?.includes("Revision 2, answering MK-3")) wrong.push("the mockup row does not say its round and what it revises");
        wrong.push(...open("REQ-49"));
        await settle();
        await new Promise((r) => setTimeout(r, 1500));
        if (!peek()?.querySelector("[data-testid=approval-peek-mockup] iframe[sandbox=allow-scripts]")) wrong.push("the peek does not run the mockup in the isolated frame");
        return [...wrong, ...peekReads("proposal", "mockup", "foot")];
      },
    },
    {
      name: "decline-reason-light",
      run: async () => {
        theme("light");
        closePeek();
        await search("");
        rowOf("FB-139")?.querySelector<HTMLElement>("[data-testid=approval-decline]")?.click();
        await settle();
        peek()?.querySelector<HTMLElement>("[data-testid=approval-words-send]")?.click();
        await settle();
        const alert = peek()?.querySelector("[role=alert]")?.textContent ?? "";
        return alert.includes("A decline needs a reason") ? sideways() : ["an empty decline is not refused in place"];
      },
    },
    {
      name: "question-named-dark",
      run: async () => {
        theme("dark");
        closePeek();
        await search("ISS-41");
        const row = rowOf("ISS-41");
        const sends = row?.querySelector<HTMLElement>("[data-testid=approval-approve]");
        const wrong: string[] = [];
        if (!sends?.textContent?.includes("Keep the old order")) wrong.push(`the question's ✓ reads "${sends?.textContent ?? ""}", not the answer it sends`);
        if (row?.querySelector("[data-testid=approval-decline]")) wrong.push("a question with no declining answer draws a ✕");
        row?.querySelector<HTMLElement>("[data-testid=approval-other-answers]")?.click();
        await settle();
        const answers = [...(peek()?.querySelectorAll("[data-testid=approval-peek-answer-label]") ?? [])].map((b) => b.textContent);
        if (answers.join("|") !== "Keep the old order|Use the new order") wrong.push(`its peek offers "${answers.join("|")}"`);
        return [...wrong, ...peekReads("proposal", "stakes", "foot")];
      },
    },
    {
      name: "release-decline-light",
      run: async () => {
        theme("light");
        closePeek();
        await search("0.4.0-dev.270");
        const row = rowOf("0.4.0-dev.270");
        const wrong: string[] = [];
        if (!row?.querySelector("[data-testid=approval-approve]")?.textContent?.includes("Approve 0.4.0-dev.270")) wrong.push("the release's ✓ does not name its approve");
        row?.querySelector<HTMLElement>("[data-testid=approval-decline]")?.click();
        await settle();
        const field = peek()?.querySelector<HTMLTextAreaElement>("[data-testid=approval-words]");
        if (field?.placeholder !== "Why not?") wrong.push(`the release's ✕ asks "${field?.placeholder ?? "nothing"}", not why`);
        return [...wrong, ...sideways()];
      },
    },
    {
      name: "peek-release-merges-light",
      run: async () => {
        theme("light");
        closePeek();
        await search("0.4.0-dev.270");
        const wrong = open("0.4.0-dev.270");
        await settle();
        const merges = [...(peek()?.querySelectorAll<HTMLElement>("[data-testid=release-merge]") ?? [])];
        const read = merges.map((m) => m.textContent ?? "");
        if (read.join("|") !== "1!5008openISS-1ISS-4ISS-5|2!5009openISS-10ISS-11ISS-12ISS-13") wrong.push(`the peek's merges read ${JSON.stringify(read)}`);
        for (const m of merges) if (m.getBoundingClientRect().right > window.innerWidth + 0.5) wrong.push("a merge row runs past the window's right edge");
        return [...wrong, ...peekReads("proposal", "merges", "foot")];
      },
    },
    {
      name: "bulk-light",
      run: async () => {
        closePeek();
        await search("");
        document.querySelector<HTMLElement>("[data-testid=approval-group-feedback] [role=checkbox]")?.click();
        await settle();
        const summary = document.querySelector("[data-testid=approval-bulk-summary]")?.textContent ?? "";
        // a group selects the three it shows, never one the person has not seen
        const want = "Approving makes 2 new issues · 1 requirement revision · 2 marked Check first";
        return summary.includes(want) ? sideways() : [`the bulk bar reads "${summary}", not "${want}"`];
      },
    },
    {
      name: "after-approve-light",
      run: async () => {
        document.querySelector<HTMLElement>("[data-testid=approval-bulk-clear]")?.click();
        await settle();
        await search("requirement-to-delivery");
        const wrong = open("requirement-to-delivery");
        await settle();
        peek()?.querySelector<HTMLElement>("[data-testid=approval-peek-answer][data-answer=approve]")?.click();
        await settle();
        const undo = document.querySelector("[data-testid=approval-undo]")?.textContent ?? "";
        if (!undo.includes("requirement-to-delivery approved")) wrong.push(`the Undo bar reads "${undo}"`);
        // the search matched that one row, so the peek has no next row to step on to and closes
        if (peek()) wrong.push("the peek stays open with no row left to show");
        return [...wrong, ...sideways()];
      },
    },
  ],
};
