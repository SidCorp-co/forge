// A request going through its one value check, on the requirement's page, at phone and desktop width in
// light and dark (REQ-65 BC-1..BC-6; ISS-690). REQ-1 is held by a question on whom it is for. The
// person picks a chip, the check runs again, and it ends accepted, each fact naming its source. REQ-2's
// check refused it with one line. The person keeps it with a one-line reason of their own, and the keep
// reads under the refusal. jsdom lays nothing out, so a row cut at 390 px or a page scrolling sideways
// goes red only here.
//
//   pnpm --filter web-v2 witness witness/value-check.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type { IntakeDraftView, IntakeQuestionView, ValueCheckView } from "@/features/intake/types";
import { RequirementPage } from "@/features/requirements/components/requirement-detail";
import type { RequirementDetail } from "@/features/requirements/types";
import { say, waitingOn } from "@/test/said";
import { reqDetail } from "@/test/vi-chrome-requirements";
import { settle, sideways } from "./connect-flow.fixture";
import "./entry";
import { InRouter } from "./router";

const P = "7f1c1d1e-0000-4000-8000-000000000690";
const AT = "2026-10-25T08:00:00.000Z";
const ANN = { id: "u-ann", name: "Ann" };

const ref = (key: string, title: string) => ({ kind: "requirement" as const, key, title });
const REQ1 = ref("REQ-1", "Weekly referral report");
const REQ2 = ref("REQ-2", "Animated logo on the board");

const who: IntakeQuestionView = {
  number: 1,
  prompt: "Who reads the referral report?",
  changes: "scope",
  options: [
    { id: "clerks", label: "Clinic clerks", effect: "Built for the front desk" },
    { id: "managers", label: "Ward managers", effect: "Built for the weekly review" },
  ],
  recommended: "managers",
  blocks: "problem",
  answer: null,
};
const often: IntakeQuestionView = {
  number: 2,
  prompt: "How often is it sent?",
  changes: "scope",
  options: [
    { id: "weekly", label: "Weekly", effect: "One report each Monday" },
    { id: "monthly", label: "Monthly", effect: "One report a month" },
  ],
  recommended: "weekly",
  blocks: null,
  answer: null,
};

const value = (over: Partial<ValueCheckView>): ValueCheckView => ({
  who: { value: "Ward managers", source: REQ1 },
  improves: { value: "Late referrals are seen the week they slip", source: REQ1 },
  measured: { value: "Weekly", source: { kind: "recommended", question: 2 } },
  exists: null,
  outcome: { kind: "accept" },
  kept: null,
  effect: null,
  ...over,
});

const draft = (key: string, over: Partial<IntakeDraftView>): IntakeDraftView => ({
  item: { kind: "requirement", key },
  outcome: "drafted",
  code: null,
  detail: null,
  at: AT,
  model: "gateway",
  attempts: 1,
  retrying: false,
  read: { requirements: 12, workflows: 3, feedback: 9, releases: 2 },
  links: [],
  notAffected: [],
  assumptions: [],
  questions: [often],
  answered: [],
  nothingToAsk: null,
  applied: null,
  value: value({}),
  can: { answer: true, keep: false },
  ...over,
});

const answered = { option: "managers", label: "Ward managers", by: ANN, at: AT };
const DRAFTS: Record<string, IntakeDraftView[]> = {
  // held, then answered and checking again, then drafted again with the answer: accepted
  "REQ-1": [
    draft("REQ-1", { questions: [who, often], value: value({ who: null, outcome: null }) }),
    draft("REQ-1", { questions: [{ ...who, answer: answered }, often], value: value({ who: null, outcome: null }) }),
    draft("REQ-1", { answered: [{ prompt: who.prompt, label: "Ward managers", by: ANN, at: AT }] }),
  ],
  // refused with its one line, then kept by a person with theirs
  "REQ-2": [
    draft("REQ-2", {
      questions: [],
      nothingToAsk: "The record settles it.",
      value: value({
        who: { value: "Nobody named", source: REQ2 },
        improves: { value: "The board looks livelier", source: REQ2 },
        measured: { value: "No measure given", source: REQ2 },
        outcome: { kind: "refuse", reason: "It names no one it helps and nothing it improves." },
        effect: { as: "refused" },
      }),
      can: { answer: true, keep: true },
    }),
    draft("REQ-2", {
      questions: [],
      nothingToAsk: "The record settles it.",
      value: value({
        who: { value: "Nobody named", source: REQ2 },
        improves: { value: "The board looks livelier", source: REQ2 },
        measured: { value: "No measure given", source: REQ2 },
        outcome: { kind: "refuse", reason: "It names no one it helps and nothing it improves." },
        kept: { reason: "The clinic's open day needs it on the lobby board.", by: ANN, at: AT },
        effect: { as: "refused" },
      }),
    }),
  ],
};
const step: Record<string, number> = { "REQ-1": 0, "REQ-2": 0 };
let answeredAt = 0;
const now = (key: string) => DRAFTS[key]?.[step[key] ?? 0] ?? null;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://witness.test").pathname.replace(/^\/api/, "");
  const method = init?.method ?? "GET";
  const m = /\/intake-drafts\/(REQ-\d+)(\/answers|\/keep)?$/.exec(path);
  if (m?.[1]) {
    const key = m[1];
    if (method === "POST") {
      step[key] = (step[key] ?? 0) + 1;
      answeredAt = Date.now();
    }
    if (method === "POST" && path.endsWith("/keep")) client.setQueryData(["requirement", P, key], detail(REQ2, "draft", TLDR2));
    // a read a moment after the answer finds the assistant's next draft, made with it
    else if (key === "REQ-1" && step[key] === 1 && Date.now() - answeredAt > 2000) step[key] = 2;
    return json({ draft: now(key) });
  }
  return new Promise<Response>(() => {});
};

// the standing core reads off the status: a draft waits on its author, a refused one on nobody
const standingOf = (status: RequirementDetail["status"]): RequirementDetail["standing"] => ({
  ...reqDetail.standing,
  state: status,
  next: status === "draft" ? "agreed" : null,
  attentionGroup: status === "refused" ? "done" : "waiting",
  waitingOn:
    status === "refused"
      ? waitingOn("none", { who: say("standing.who.dash"), act: say("standing.act.none"), rule: say("requirements.rule.ended", { status }) })
      : waitingOn("person", { who: say("standing.who.named", { name: "Ann" }), act: say("standing.act.finishDraft"), rule: say("requirements.rule.ended", { status }) }),
} as RequirementDetail["standing"]);

const detail = (r: { key: string; title: string }, status: RequirementDetail["status"], tldr: string): RequirementDetail => ({
  ...reqDetail,
  id: `id-${r.key}`,
  key: r.key,
  title: r.title,
  status,
  standing: standingOf(status),
  questions: [],
  unclear: 0,
  revisions: reqDetail.revisions.filter((x) => x.state === "current").map((x) => ({ ...x, tldr, spec: { ...x.spec, goal: tldr, assumptions: [] } })),
});

const TLDR2 = "Animate the clinic logo on the ward board.";
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(["requirement", P, "REQ-1"], detail(REQ1, "draft", "Ward managers get a weekly list of referrals that slipped."));
client.setQueryData(["requirement", P, "REQ-2"], detail(REQ2, "refused", TLDR2));
const root = createRoot(document.getElementById("root") as HTMLElement);
function show(key: string) {
  root.render(
    <InRouter at={`/projects/hop/requirements/${key}`} pattern="/projects/$slug/requirements/$requirement">
      <QueryClientProvider client={client}>
        <div className="min-h-screen bg-app text-fg">
          <RequirementPage key={key} projectId={P} slug="hop" reqKey={key} tab="overview" onTab={() => {}} />
        </div>
      </QueryClientProvider>
    </InRouter>,
  );
}
show("REQ-1");

const q = (sel: string, from: ParentNode = document) => from.querySelector<HTMLElement>(sel);
const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
async function until(test: () => boolean, what: string, tries = 160): Promise<string[]> {
  for (let i = 0; i < tries; i += 1) {
    if (test()) return [];
    await settle(50);
  }
  return [`${what} is not drawn`];
}
const outcome = () => q("[data-testid=value-check]")?.dataset.outcome;
const text = (sel: string) => q(sel)?.textContent ?? "";
/** The check in view, so the shot shows it rather than the page's top. */
const toCheck = () => q("[data-testid=value-check]")?.scrollIntoView({ block: "start" });
function type(el: HTMLInputElement, v: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
/** No row is cut: every value-check row's text fits its own box. */
function uncut(): string[] {
  const wrong = sideways();
  for (const el of document.querySelectorAll<HTMLElement>("[data-testid=value-check] dd, [data-testid=value-check] dt")) {
    if (el.scrollWidth > el.clientWidth + 1) wrong.push(`"${el.textContent?.slice(0, 40)}" is cut at ${window.innerWidth} px`);
  }
  return wrong;
}

async function held(): Promise<string[]> {
  theme("light");
  const wrong = await until(() => outcome() === "held", "REQ-1's held check");
  toCheck();
  if (!text("[data-testid=value-who]").includes("Not given")) wrong.push("the missing problem does not read as not given");
  if (!text("[data-testid=intake-question][data-blocks=problem]").includes("Blocks on who it serves")) wrong.push("the blocking question does not say what it blocks on");
  if (!text("[data-testid=value-measured]").includes("Recommended answer to question 2")) wrong.push("the assumed measure does not name its question");
  return [...wrong, ...uncut()];
}

async function accepted(t: "light" | "dark"): Promise<string[]> {
  theme(t);
  const wrong: string[] = [];
  if (t === "light") {
    const chip = [...document.querySelectorAll<HTMLButtonElement>("[data-testid=intake-question][data-blocks=problem] button")].find((b) => b.textContent?.includes("Ward managers"));
    if (!chip) return ["the blocking question offers no Ward managers chip"];
    chip.click();
    wrong.push(...(await until(() => text("[data-testid=value-outcome]").includes("checking again"), "the answered check running again")));
    wrong.push(...(await until(() => outcome() === "accept", "REQ-1's accepted check", 240)));
  }
  await settle(200);
  toCheck();
  if (!text("[data-testid=value-who]").includes("Ward managers")) wrong.push("the answered problem is not shown");
  if (!text("[data-testid=intake-answered]").includes("Ward managers")) wrong.push("the answer it was drafted with is not listed");
  return [...wrong, ...uncut()];
}

async function refused(t: "light" | "dark"): Promise<string[]> {
  theme(t);
  if (t === "light") show("REQ-2");
  const wrong = await until(() => outcome() === "refuse", "REQ-2's refused check");
  toCheck();
  if (!text("[data-testid=value-reason]").includes("names no one it helps")) wrong.push("the refusal's one line is not shown");
  if (!q("[data-testid=value-keep]")) wrong.push("the keep form is not offered on a refused request");
  return [...wrong, ...uncut()];
}

async function kept(t: "light" | "dark"): Promise<string[]> {
  theme(t);
  const wrong: string[] = [];
  if (t === "light") {
    const input = q("[data-testid=value-keep] input") as HTMLInputElement | null;
    if (!input) return ["the keep form has no input"];
    type(input, "The clinic's open day needs it on the lobby board.");
    await settle(100);
    q("[data-testid=value-keep] button[type=submit]")?.click();
    wrong.push(...(await until(() => Boolean(q("[data-testid=value-kept]")), "the keep")));
  }
  await settle(200);
  toCheck();
  if (!text("[data-testid=value-kept]").includes("open day")) wrong.push("the keep's reason is not shown");
  return [...wrong, ...uncut()];
}

window.__witness = {
  cases: [
    { name: "phone", width: 390 },
    { name: "desktop", width: 1440 },
  ],
  ready: () => Boolean(q("[data-testid=value-check]")),
  stages: [
    { name: "1-held-light", run: held },
    { name: "2-accepted-light", run: () => accepted("light") },
    { name: "3-accepted-dark", run: () => accepted("dark") },
    { name: "4-refused-light", run: () => refused("light") },
    { name: "5-refused-dark", run: () => refused("dark") },
    { name: "6-kept-light", run: () => kept("light") },
    { name: "7-kept-dark", run: () => kept("dark") },
  ],
};
