// The decision panel witnessed in the shell's own frame (REQ-48 r3 BC-13, BC-14, BC-15): the Approvals
// page under the phone's bottom tab bar at 390 px and beside a 48 px top strip at 1440 px, three peeks
// opened in turn: the steward's question on ISS-625 (four answers, one a merge whose label runs long),
// a feedback suggestion and a design update. Each stage presses nothing: it scrolls every answer into
// view and asks whether the point at its centre is the answer itself, so a button under the tab bar
// or past the panel's edge fails by name. It counts the title, the question, the reason and each
// answer's label and effect in the peek's text (each once), reads the evidence an issue decision rests
// on, and checks the keys the foot hints are the answers it shows.
//
//   pnpm --filter web-v2 witness witness/decision-panel.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { BottomTabBar, TopBarSlotProvider, useTopBarSlotTargets } from "@/design";
import { ApprovalsScreen } from "@/features/approvals";
import { bottomTabItems } from "@/features/shell/nav-model";
import { APPROVALS_PROJECT as P, APPROVALS_READ, STEWARD_625, STEWARD_625_REASON } from "@/test/approvals-read";
import "./entry";
import { InRouter } from "./router";

const PHONE = 768;
const DECISIONS = [STEWARD_625, ...APPROVALS_READ.decisions];
const READ = { ...APPROVALS_READ, total: DECISIONS.length, decisions: DECISIONS };
const phone = window.innerWidth < PHONE;

window.localStorage.clear();
window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes(`/projects/${P}/needs-you/decisions`)) return new Response(JSON.stringify(READ), { headers: { "content-type": "application/json" } });
  return new Promise<Response>(() => {});
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** The shell's 48 px bar, which the page names itself into, as `ShellTopBar` draws it. */
function Bar() {
  const { titleRef } = useTopBarSlotTargets();
  return (
    <header className="flex h-12 flex-none items-center gap-3 border-b border-line bg-surface px-4 sm:px-6">
      <div ref={titleRef} className="flex min-w-0 flex-1 items-center gap-2" />
    </header>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/approvals" pattern="/projects/$slug/approvals">
    <QueryClientProvider client={client}>
      <TopBarSlotProvider>
      <div className="flex h-dvh overflow-hidden bg-shell">
        <div className="flex min-w-0 flex-1 flex-col">
          <Bar />
          <main className="min-h-0 flex-1 overflow-y-auto bg-app pb-[calc(56px+env(safe-area-inset-bottom))] window-md:pb-0">
            <ApprovalsScreen projectId={P} slug="hop" />
          </main>
        </div>
        <BottomTabBar items={bottomTabItems(READ.total)} activeKey="attention" onSelect={() => {}} />
      </div>
      </TopBarSlotProvider>
    </QueryClientProvider>
  </InRouter>,
);

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-testid=approval-row]")];
const rowOf = (key: string) => rows().find((r) => r.querySelector("[data-testid=approval-open]")?.textContent?.includes(key));
const peek = () => document.querySelector<HTMLElement>("[data-testid=approval-peek]");
const settle = () => new Promise((r) => setTimeout(r, 250));

function open(key: string): string[] {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  const button = rowOf(key)?.querySelector<HTMLElement>("[data-testid=approval-open]");
  if (!button) return [`no row ${key} to open`];
  button.click();
  return [];
}

/** How many times `needle` is in `hay`. */
const times = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);

/** The top edge nothing may sit under: the tab bar's where it is drawn, else the window's bottom. */
function floor(): number {
  const bar = document.querySelector<HTMLElement>("nav[aria-label]");
  const r = bar?.getBoundingClientRect();
  return r && r.height > 0 && getComputedStyle(bar as HTMLElement).display !== "none" ? r.top : window.innerHeight;
}

/** Every answer button of the open peek: scrolled into view, wholly inside the window above the bar, its label unclipped, and the one thing at its centre. */
function reachable(d: NeedsYouDecision): string[] {
  const p = peek();
  if (!p) return [`${d.key}: no peek is open`];
  const wrong: string[] = [];
  const buttons = [...p.querySelectorAll<HTMLElement>("[data-testid=approval-peek-answer]")];
  // a foot that marks no answer on its button is still read: the last button saying its label
  const said = (label: string) => [...p.querySelectorAll<HTMLElement>("button")].filter((x) => x.textContent?.trim() === label).at(-1);
  for (const a of d.answers) {
    const b = buttons.find((x) => x.dataset.answer === a.id) ?? said(a.label);
    if (!b) {
      wrong.push(`${d.key}: no button for "${a.label}"`);
      continue;
    }
    b.scrollIntoView({ block: "nearest" });
    const r = b.getBoundingClientRect();
    const bottom = floor();
    if (r.top < 0 || r.bottom > bottom + 0.5) wrong.push(`${d.key}: "${a.label}" sits at ${Math.round(r.top)}-${Math.round(r.bottom)} px, outside 0-${Math.round(bottom)} px above the tab bar`);
    if (r.right > window.innerWidth + 0.5 || r.left < -0.5) wrong.push(`${d.key}: "${a.label}" runs from ${Math.round(r.left)} to ${Math.round(r.right)} px in a ${window.innerWidth} px window`);
    if (b.scrollWidth > b.clientWidth + 1) wrong.push(`${d.key}: "${a.label}" is clipped: ${b.scrollWidth} px of label in ${b.clientWidth} px`);
    const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, bottom - 1));
    if (!hit || !b.contains(hit)) wrong.push(`${d.key}: "${a.label}" cannot be pressed: ${hit ? `${hit.tagName.toLowerCase()} "${(hit.textContent ?? "").trim().slice(0, 30)}"` : "nothing"} sits on it`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

/** The title, the question, the reason and each answer's label and effect, each drawn once. */
function once(d: NeedsYouDecision, reason: string | null): string[] {
  const p = peek();
  // what is asked or proposed states the decision: an approve named after the proposal's verb is its answer, not a second one
  const asked = p?.querySelector<HTMLElement>("[data-testid=approval-peek-proposal]")?.innerText ?? "";
  const text = (p?.innerText ?? "").replace(asked, "");
  const wrong: string[] = [];
  const title = d.title || d.key;
  // the title as a line of its own; a sentence quoting it (a design's "“Forge in context” was approved") is not a second title
  const titles = [...(p?.querySelectorAll<HTMLElement>("*") ?? [])].filter((el) => el.children.length === 0 && el.textContent?.trim() === title).length;
  if (titles !== 1) wrong.push(`${d.key}: the title is drawn ${titles} times`);
  if (d.proposal === null && times(p?.innerText ?? "", d.question) !== 1) wrong.push(`${d.key}: the question is drawn ${times(p?.innerText ?? "", d.question)} times`);
  if (/Recommended:/.test(text)) wrong.push(`${d.key}: the question carries its own "Recommended:"`);
  if (reason && times(text, reason) !== 1) wrong.push(`${d.key}: the reason is drawn ${times(text, reason)} times`);
  for (const a of d.answers) {
    const label = times(text, a.label);
    if (label !== 1) wrong.push(`${d.key}: "${a.label}" is drawn ${label} times`);
    if (a.effect && times(text, a.effect) !== 1) wrong.push(`${d.key}: "${a.label}"'s effect is drawn ${times(text, a.effect)} times`);
  }
  if (peek()?.querySelector(".bg-info-2")) wrong.push(`${d.key}: what is asked sits in a tinted box`);
  return wrong;
}

/** The facts an issue decision rests on: requirement and revision, plan, criteria, each a link to its page. */
function evidence(d: NeedsYouDecision): string[] {
  const block = peek()?.querySelector<HTMLElement>("[data-testid=approval-peek-evidence]");
  if (!block) return [`${d.key}: no evidence block`];
  const hrefs = [...block.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => a.getAttribute("href") ?? "");
  const wrong: string[] = [];
  if (!hrefs.some((h) => h.includes("/requirements/REQ-48"))) wrong.push(`${d.key}: the evidence does not open REQ-48`);
  if (!hrefs.some((h) => h.includes(`/issues/${d.key}`) && h.includes("view=developer"))) wrong.push(`${d.key}: the evidence does not open the plan`);
  if (!hrefs.some((h) => h.includes(`/issues/${d.key}`) && h.includes("#criteria"))) wrong.push(`${d.key}: the evidence does not open the criteria`);
  if (!/BC-5/.test(block.innerText)) wrong.push(`${d.key}: the evidence does not name the criteria's BC codes`);
  return wrong;
}

/** On a keyboard: each answer shows the key that presses it, and the foot hints no key that presses nothing shown. */
function keys(d: NeedsYouDecision): string[] {
  if (phone) return [];
  const p = peek();
  const wrong: string[] = [];
  const buttons = [...(p?.querySelectorAll<HTMLElement>("[data-testid=approval-peek-answer]") ?? [])];
  buttons.forEach((b, i) => {
    if (b.querySelector("kbd")?.textContent !== String(i + 1)) wrong.push(`${d.key}: answer ${i + 1} shows no key ${i + 1}`);
  });
  const foot = p?.querySelector<HTMLElement>("[data-testid=approval-peek-foot]")?.innerText ?? "";
  if (!d.answers.some((a) => a.id === "approve") && /\bapprove\b/i.test(foot.replace(/Approve[^\n]*/g, ""))) wrong.push(`${d.key}: the foot hints "a approve" on a decision with no approve`);
  const hint = p?.querySelector<HTMLElement>("[data-testid=peek-keys]");
  const r = hint?.getBoundingClientRect();
  if (!hint || !r || r.height === 0 || r.bottom > window.innerHeight + 0.5 || r.top < 0) wrong.push(`${d.key}: the j/k/Enter/Esc keys are not in view`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => rows().length === READ.total,
  stages: [
    {
      name: "question-iss-625",
      run: async () => {
        const wrong = open(STEWARD_625.key);
        await settle();
        return [...wrong, ...once(STEWARD_625, STEWARD_625_REASON), ...evidence(STEWARD_625), ...keys(STEWARD_625), ...reachable(STEWARD_625)];
      },
    },
    {
      name: "feedback-suggestion",
      run: async () => {
        const d = DECISIONS.find((x) => x.key === "FB-135") as NeedsYouDecision;
        const wrong = open(d.key);
        await settle();
        return [...wrong, ...once(d, null), ...keys(d), ...reachable(d)];
      },
    },
    {
      name: "design-update",
      run: async () => {
        const d = DECISIONS.find((x) => x.key === "system-context") as NeedsYouDecision;
        const wrong = open(d.key);
        await settle();
        return [...wrong, ...once(d, null), ...keys(d), ...reachable(d)];
      },
    },
  ],
};
