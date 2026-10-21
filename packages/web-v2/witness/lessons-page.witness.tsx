// The Lessons page witnessed as drawn (REQ-50), at phone and desktop width, light and dark: the
// confusion first with both sides and its recommended answer marked, the steward's proposal with
// approve, edit and reject, the lessons in use with their provenance and use (one held, one proposed
// for retirement with Keep, one that became a check), the corrections still waiting, and the month.
// Then one lesson's sources opened: the corrections it learned from and where it was applied, each
// with "Wrongly applied". Every button and line stays inside the window at 390 px.
//
//   pnpm --filter web-v2 witness witness/lessons-page.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { LessonsPage } from "@/features/lessons";
import "./entry";
import { stubLessonsCore } from "./lessons.fixture";
import { InRouter } from "./router";

window.localStorage.clear();
stubLessonsCore();
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter>
    <QueryClientProvider client={client}>
      <LessonsPage projectId="p1" now={new Date("2026-10-21T09:00:00Z")} />
    </QueryClientProvider>
  </InRouter>,
);

const theme = (t: "light" | "dark") => {
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle("dark", t === "dark");
};
const settle = () => new Promise((r) => setTimeout(r, 200));
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);

function inside(): string[] {
  const wrong: string[] = [];
  for (const el of document.querySelectorAll("[data-testid=lessons-page] button, [data-testid=lessons-page] li")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > window.innerWidth + 0.5) wrong.push(`"${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}" runs past the window's right edge`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${window.innerWidth}`);
  return wrong;
}

function drawn(): string[] {
  const wrong: string[] = [];
  const order = ["lessons-confusions", "lessons-proposed", "lessons-approved", "lessons-corrections", "lessons-month"].map((id) => $(`[data-testid=${id}]`));
  if (order.some((s) => !s)) return ["a section of the page is missing"];
  const tops = order.map((s) => (s as HTMLElement).getBoundingClientRect().top);
  if (tops.some((t, i) => i > 0 && t < (tops[i - 1] as number))) wrong.push("the confusions do not come first, or the sections are out of order");
  const recommended = document.querySelectorAll("[data-testid=lesson-confusion] [data-recommended]");
  if (recommended.length !== 1 || !recommended[0]?.textContent?.includes("Edit")) wrong.push("the confusion does not mark its one recommended answer, Edit");
  if (!$("[data-testid=lessons-proposed] [data-testid=lesson-approve]")) wrong.push("the proposal offers no Approve");
  if (!$("[data-testid=lesson-retire-proposal]") || !$("[data-testid=lesson-keep]")) wrong.push("the unused lesson shows no retire proposal with Keep");
  if (!document.body.textContent?.includes("Check ISS-91")) wrong.push("the repeated lesson does not name its check");
  if (document.querySelectorAll("[data-testid=lesson-correction-row]").length !== 2) wrong.push("the waiting corrections are not both listed");
  if (!$("[data-testid=lessons-month-repeats]")?.textContent?.includes("1")) wrong.push("the month does not count its repeat");
  return wrong;
}

window.__witness = {
  cases: [
    { name: "lessons-phone", width: 390 },
    { name: "lessons-desktop", width: 1280 },
  ],
  ready: () => $("[data-testid=lesson-confusion]") !== null && $("[data-testid=lessons-month-repeats]") !== null,
  stages: [
    {
      name: "light",
      run: async () => {
        theme("light");
        await settle();
        return [...drawn(), ...inside()];
      },
    },
    {
      name: "dark",
      run: async () => {
        theme("dark");
        await settle();
        return inside();
      },
    },
    {
      name: "sources-light",
      run: async () => {
        theme("light");
        const toggles = document.querySelectorAll<HTMLElement>("[data-testid=lessons-approved] [data-testid=lesson-sources-toggle]");
        toggles[0]?.click();
        await settle();
        const sources = $("[data-testid=lessons-approved] [data-testid=lesson-sources]");
        if (!sources) return ["Sources opened nothing under the lesson"];
        const wrong: string[] = [];
        if (sources.querySelectorAll("[data-testid=lesson-correction]").length !== 2) wrong.push("the lesson's provenance does not list its two corrections");
        if (sources.querySelectorAll("[data-testid=lesson-wrong]").length !== 1) wrong.push("the application not yet marked offers no Wrongly applied, or the marked one still does");
        if (!sources.textContent?.includes("Marked wrongly applied")) wrong.push("the marked application does not say so");
        $("[data-testid=lesson-wrong]")?.click();
        await settle();
        if (!$("[data-testid=reject-step]")) wrong.push("Wrongly applied asks for no reason");
        return [...wrong, ...inside()];
      },
    },
    {
      name: "sources-dark",
      run: async () => {
        theme("dark");
        await settle();
        return inside();
      },
    },
  ],
};
