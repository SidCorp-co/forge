// A suggestion's author's own acts witnessed as drawn: Revise and Withdraw beside the suggestion, and
// the revise form, each of the payload's words a field and every field one fold away. At 390 px the
// form's fields and buttons stay inside the window. Shot light and dark, form closed and open.
//
//   pnpm --filter web-v2 witness witness/suggestion-author-acts.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { SuggestionAuthorActs } from "@/features/suggestions/components/suggestion-author-acts";
import type { SuggestionView } from "@/features/suggestions/types";
import "./entry";
import { InRouter } from "./router";

const s = {
  id: "s-mine",
  kind: "revision_diff",
  status: "proposed",
  target: { type: "requirement", id: "r1" },
  baseRevision: 2,
  producerKind: "person",
  producerId: "u-me",
  model: null,
  createdAt: new Date().toISOString(),
  payload: {
    reason: "the nurse needs the handover before the shift ends",
    tldr: "Hand a case over at shift change",
    changeSummary: "Adds BC-4: the handover is signed by both nurses",
    criteria: [{ code: "BC-4", body: "Both nurses sign the handover." }],
  },
} as unknown as SuggestionView;

window.localStorage.clear();
window.fetch = () => new Promise<Response>(() => {});
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter>
    <QueryClientProvider client={client}>
      <div className="min-h-screen bg-app p-4">
        <p className="mb-3 text-13-5 font-medium text-fg">REQ-7 · Revision diff</p>
        <div className="flex flex-wrap items-center gap-2" data-testid="witness-acts">
          <SuggestionAuthorActs projectId="p1" s={s} affected={[]} busy={false} />
        </div>
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const settle = () => new Promise((r) => setTimeout(r, 150));

function inside(): string[] {
  const wrong: string[] = [];
  for (const el of document.querySelectorAll("[data-testid=witness-acts] button, [data-testid=witness-acts] textarea, [data-testid=witness-acts] input")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > window.innerWidth + 0.5) wrong.push(`"${el.getAttribute("aria-label") ?? el.textContent?.trim()}" runs past the window's right edge`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

window.__witness = {
  cases: [
    { name: "acts-phone", width: 390 },
    { name: "acts-desktop", width: 1280 },
  ],
  ready: () => document.querySelector("[data-testid=suggestion-revise-open]") !== null,
  stages: [
    {
      name: "light",
      run: async () => {
        theme("light");
        await settle();
        const wrong = inside();
        if (!document.querySelector("[data-testid=suggestion-withdraw]")) wrong.push("the author is offered no Withdraw");
        return wrong;
      },
    },
    {
      name: "revise-light",
      run: async () => {
        document.querySelector<HTMLElement>("[data-testid=suggestion-revise-open]")?.click();
        await settle();
        const form = document.querySelector("[data-testid=suggestion-revise]");
        if (!form) return ["Revise opened no form"];
        const fields = form.querySelectorAll("textarea").length;
        return [...inside(), ...(fields === 3 ? [] : [`the form draws ${fields} word fields, not the payload's 3`])];
      },
    },
    {
      name: "revise-dark",
      run: async () => {
        theme("dark");
        await settle();
        return inside();
      },
    },
  ],
};
