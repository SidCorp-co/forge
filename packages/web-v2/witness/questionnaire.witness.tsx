// The onboarding questionnaire card after REQ-10 r4, witnessed at desktop and phone width: a round
// asks at most three questions, each with its Recommended answer marked, and lists what the code
// suggested as Assumptions, read-only with their evidence until the person presses Change, which
// opens the choice marked Assumed. A fifteen-item batch posted before r4 — inferred answers and
// accept / reject recommendations among its items — still reads. Red when the page scrolls sideways,
// a control is cut off at the window's edge, a mark is not drawn, or the copy is not English.
//
//   pnpm --filter web-v2 witness witness/questionnaire.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Questionnaire } from "@/features/onboarding/components/questionnaire";
import type { QuestionnaireItemView, QuestionnaireView } from "@/features/onboarding/types";
import { settle, sideways, windowWidth } from "./connect-flow.fixture";
import "./entry";

const AT = "2026-10-21T09:00:00.000Z";
const AGENT = "agent-1";

const item = (id: string, prompt: string, over: Partial<QuestionnaireItemView> = {}): QuestionnaireItemView => ({
  id,
  group: "question",
  control: "choice",
  prompt,
  options: [
    { id: "a", label: "Yes, every order" },
    { id: "b", label: "Only paid orders" },
  ],
  inferredDefault: "a",
  why: "The designs read differently on each answer.",
  evidence: ["apps/api/src/orders/order.entity.ts:Order"],
  affects: ["order-lifecycle"],
  questionId: `q-${id}`,
  state: "open",
  answer: null,
  answeredBy: null,
  answeredAt: null,
  ...over,
});

const assumed = (id: string, prompt: string, options: { id: string; label: string }[], evidence: string[]) =>
  item(id, prompt, {
    group: "assumption",
    options,
    inferredDefault: options[0]?.id,
    evidence,
    state: "answered",
    answer: { choice: options[0]?.id ?? "" },
    answeredBy: AGENT,
    answeredAt: AT,
  });

const batch = (id: string, title: string, round: number, items: QuestionnaireItemView[]): QuestionnaireView => ({
  id,
  conversationId: "c1",
  onboardingId: "o1",
  requirementId: null,
  firstRequirementsOf: null,
  title,
  intro: null,
  round,
  maxRounds: 3,
  status: "open",
  items,
  answered: items.filter((i) => i.state === "answered").length,
  open: items.filter((i) => i.state === "open").length,
  postedBy: AGENT,
  postedAt: AT,
  submittedBy: null,
  submittedAt: null,
  skippedAt: null,
  supersededAt: null,
  supersededBy: null,
  messageId: null,
  answersMessageId: null,
  sensitiveData: "off",
});

const r4 = batch("b-r4", "What the code cannot answer", 1, [
  item("q-refund-owner", "Who approves a refund over the shop limit?", {
    options: [
      { id: "manager", label: "The store manager" },
      { id: "finance", label: "Finance" },
      { id: "nobody", label: "No approval" },
    ],
    inferredDefault: "manager",
  }),
  item("q-archive", "Should a cancelled order still show in the customer's history?"),
  assumed(
    "a-central-entity",
    "Which entity do most modules reference?",
    [
      { id: "order", label: "Order" },
      { id: "cart", label: "Cart" },
    ],
    ["apps/api/src/orders/order.entity.ts:Order", "apps/api/src/app.module.ts:AppModule"],
  ),
  assumed(
    "a-payment",
    "How is a payment confirmed?",
    [
      { id: "stripe", label: "Stripe webhooks" },
      { id: "manual", label: "Manual reconciliation" },
    ],
    ["apps/api/src/payments/stripe.webhook.ts:handleStripeEvent"],
  ),
]);

// fifteen items as the catalog and epod rounds posted them before r4: inferred defaults on every
// question, accept / reject recommendations, and an open text clarification
const legacy = batch("b-legacy", "Onboarding round 1", 1, [
  ...Array.from({ length: 10 }, (_, i) =>
    item(`q${i + 1}`, `Is status ${i + 1} of the catalog sync still written by the importer job?`, {
      options: [
        { id: "yes", label: "Yes (inferred)" },
        { id: "no", label: "No, it is retired" },
      ],
      inferredDefault: "yes",
    }),
  ),
  item("c1", "Which team owns the Bosch price feed?", { group: "clarification", control: "text", options: [], inferredDefault: undefined }),
  ...Array.from({ length: 4 }, (_, i) =>
    item(`r${i + 1}`, `Recommend retrying failed imports with backoff (${i + 1} of 4)`, {
      group: "recommendation",
      control: "accept_reject",
      options: [],
      inferredDefault: undefined,
    }),
  ),
]);

const root = createRoot(document.getElementById("root") as HTMLElement);
window.fetch = async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } });

// drawn before the stage reads it: a scheduled render would leave the last stage's card in the DOM
function show(b: QuestionnaireView) {
  flushSync(() => root.render(
    <QueryClientProvider key={`${b.id}-${Math.random()}`} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div className="min-h-screen bg-app p-4 text-fg">
        <div className="mx-auto max-w-3xl">
          <Questionnaire projectId="p1" batch={b} designTitle={(r) => (r === "order-lifecycle" ? "Order lifecycle" : r)} />
        </div>
      </div>
    </QueryClientProvider>,
  ));
}

const q = (sel: string, from: ParentNode = document) => from.querySelector<HTMLElement>(sel);
const all = (sel: string, from: ParentNode = document) => [...from.querySelectorAll<HTMLElement>(sel)];
const button = (from: ParentNode, text: string) => [...from.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

async function until(test: () => boolean, what: string): Promise<string[]> {
  for (let i = 0; i < 60; i += 1) {
    if (test()) return [];
    await settle(50);
  }
  return [`${what} is not drawn`];
}

/** A control whose right edge passes the window: cut off on a phone. */
function cutOff(): string[] {
  return all("input, button")
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > windowWidth() + 1;
    })
    .slice(0, 3)
    .map((el) => `a control ends at ${Math.round(el.getBoundingClientRect().right)} px in ${windowWidth()}: "${(el.textContent ?? "").trim().slice(0, 40)}"`);
}

/** Forge's copy is English: a Vietnamese letter on the card is copy that should not be there. */
function notEnglish(): string[] {
  const text = q("[data-testid=questionnaire-card]")?.textContent ?? "";
  const hit = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.exec(text);
  return hit ? [`the card holds non-English copy near "${text.slice(Math.max(0, hit.index - 20), hit.index + 20)}"`] : [];
}

const marks = (from: ParentNode, word: string) => all("span", from).filter((s) => s.textContent?.trim() === word && s.children.length === 0);

async function round(): Promise<string[]> {
  show(r4);
  const wrong = await until(() => q("[data-testid=questionnaire-assumption]") !== null, "the Assumptions list");
  const rows = all("[data-testid=questionnaire-assumption]");
  if (rows.length !== 2) wrong.push(`${rows.length} assumptions are listed, not 2`);
  for (const r of rows) if (!r.querySelector("code")) wrong.push(`the assumption "${r.textContent?.slice(0, 40)}" shows no evidence`);
  if (marks(document, "Recommended").length !== 2) wrong.push(`${marks(document, "Recommended").length} Recommended marks are drawn, not 2`);
  if (!document.body.textContent?.includes("Answered 0 of 2")) wrong.push("the counter does not count the two questions only");
  window.scrollTo(0, 0);
  return [...wrong, ...sideways(), ...cutOff(), ...notEnglish()];
}

async function changed(): Promise<string[]> {
  show(r4);
  const wrong = await until(() => q("[data-testid=questionnaire-assumption]") !== null, "the Assumptions list");
  const first = all("[data-testid=questionnaire-assumption]")[0];
  const change = first && button(first, "Change");
  if (!change) return [...wrong, "the first assumption has no Change control"];
  change.click();
  wrong.push(...(await until(() => marks(first, "Assumed").length === 1, "the Assumed mark on the opened assumption")));
  window.scrollTo(0, 0);
  return [...wrong, ...sideways(), ...cutOff(), ...notEnglish()];
}

async function old(): Promise<string[]> {
  show(legacy);
  const wrong = await until(() => q("[data-testid=questionnaire-card]") !== null && all("[data-testid=questionnaire-card] input").length > 0, "the legacy batch");
  if (!document.body.textContent?.includes("Answered 0 of 15")) wrong.push("the legacy batch does not count its fifteen open items");
  if (q("[data-testid=questionnaire-assumption]")) wrong.push("the legacy batch lists an assumption it never had");
  window.scrollTo(0, 0);
  return [...wrong, ...sideways(), ...cutOff(), ...notEnglish()];
}

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440 },
    { name: "phone-390", width: 390 },
  ],
  ready: () => q("#root") !== null,
  stages: [
    { name: "1-round", run: round },
    { name: "2-assumption-changed", run: changed },
    { name: "3-legacy-fifteen", run: old },
  ],
};
