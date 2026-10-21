// The pages a release judge read explaining lines and sentence-long empty states on (ISS-496 round 2,
// REQ-43 BC-4, BC-6), drawn at 1440 by 900: project settings (General, People, Delivery, Advanced),
// the Releases list, a box's page, a feedback item and an issue. Every line a page draws is read
// against the shapes the copy check refuses (`.forge/conformance.json` checkers.copy-budget): a
// second sentence, a gloss after a colon, a purpose clause, and an empty state over two words. The
// check reads the copy files; this reads what the page draws from them, its fallbacks included.
//
//   pnpm --filter web-v2 witness witness/copy-shapes.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ChromeScreen } from "@/test/vi-chrome-screens";
import { SCREENS as FEEDBACK_SCREENS } from "@/test/vi-chrome-feedback";
import { SCREENS as ISSUE_SCREENS } from "@/test/vi-chrome-issues";
import { SCREENS as SETTINGS_SCREENS } from "@/test/vi-chrome-project-settings.fixture";
import { SCREENS as RELEASE_SCREENS } from "@/test/vi-chrome-rel-wf";
import { SCREENS as RUNNER_SCREENS } from "@/test/vi-chrome-runners";
import { SAID_ENTRIES } from "@forge/contracts/said";
import { PRODUCT_STRINGS } from "@/lib/i18n/product-copy";
import conformance from "../../../.forge/conformance.json";
import "./entry";
import { InRouter } from "./router";

const budget = conformance.checkers["copy-budget"];
const SHAPES = budget.explainShapes.map(({ name, pattern }) => ({ name, pattern: new RegExp(pattern) }));
const EMPTY_LEAD = new RegExp(budget.emptyLead);
const PLACEHOLDER = /\{\{[^}]*\}\}|\{[^}]*\}/g;
const wordsOf = (text: string) => text.replace(PLACEHOLDER, "X").split(/\s+/).filter(Boolean).length;

// A line one template drew with its values filled in is a value, as the check reads a template whose
// gloss holds a placeholder: "Running: {n} of {total} issues in progress" is a state, not a gloss.
const escape = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
const TEMPLATES = [...Object.values(PRODUCT_STRINGS.en as Record<string, string>), ...Object.values(SAID_ENTRIES).map((e) => e.en)]
  .filter((t) => /\{[^}]*\}/.test(t))
  .map((t) => new RegExp(`^${t.split(PLACEHOLDER).map(escape).join(".+")}$`));
const drawnByTemplate = (line: string) => TEMPLATES.some((t) => t.test(line));

// the fixtures' own pages set the query string with replaceState, which a file:// page refuses for a path
const replace = window.history.replaceState.bind(window.history);
window.history.replaceState = (data, unused, url) => {
  try {
    replace(data, unused, url);
  } catch {
    /* the page stays at its file:// address; the fixtures read nothing from it */
  }
};
window.fetch = () => new Promise<Response>(() => {});

const named = (screens: ChromeScreen[], name: string): ChromeScreen => {
  const hit = screens.find((s) => s.name === name);
  if (!hit) throw new Error(`no fixture screen is named "${name}"`);
  return hit;
};

const PAGES = [
  { name: "settings-general", screen: named(SETTINGS_SCREENS as ChromeScreen[], "Project settings · General") },
  { name: "settings-people", screen: named(SETTINGS_SCREENS as ChromeScreen[], "Project settings · People") },
  { name: "settings-delivery", screen: named(SETTINGS_SCREENS as ChromeScreen[], "Project settings · Delivery") },
  { name: "settings-advanced", screen: named(SETTINGS_SCREENS as ChromeScreen[], "Project settings · Advanced") },
  { name: "releases", screen: named(RELEASE_SCREENS, "Releases") },
  { name: "runners", screen: named(RUNNER_SCREENS, "Runners") },
  { name: "feedback", screen: named(FEEDBACK_SCREENS, "Feedback detail") },
  { name: "issue", screen: named(ISSUE_SCREENS, "Issue detail") },
] as const;

const at: { show: (i: number) => void } = { show: () => {} };

class Caught extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  render() {
    return this.state.error ? <p data-witness="threw">{this.state.error}</p> : this.props.children;
  }
}

function Shell() {
  const [page, setPage] = useState(0);
  useEffect(() => {
    at.show = setPage;
  });
  const p = PAGES[page] ?? PAGES[0];
  return (
    <InRouter key={p.name} at="/projects/hop/settings" pattern="/projects/$slug/$">
      <main className="h-dvh overflow-y-auto bg-app" data-witness="page" data-witness-page={p.name}>
        <Caught key={p.name}>{p.screen.render()}</Caught>
      </main>
    </InRouter>
  );
}

/** Each line the page draws: the text of every element whose children are all text, folded. */
function linesOf(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>("*")]
    .filter((el) => el.children.length === 0 && !el.closest("[hidden],[aria-hidden='true'],script,style"))
    .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((t) => /[A-Za-z]{2}/.test(t));
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

window.__witness = {
  cases: [{ name: "wide-1440", width: 1440 }],
  ready: () => Boolean(q("[data-witness=page]")),
  stages: PAGES.map((p, i) => ({
    name: p.name,
    run: async () => {
      at.show(i);
      await pause(700);
      if (!q(`[data-witness=page][data-witness-page=${p.name}]`)) return [`the ${p.name} page is not the one drawn`];
      const threw = q("[data-witness=threw]");
      if (threw) return [`the ${p.name} page threw: ${threw.innerText.slice(0, 300)}`];
      const lines = linesOf(q("[data-witness=page]") as HTMLElement);
      if (lines.length < 5) return [`the ${p.name} page drew ${lines.length} lines: it did not draw`];
      const wrong: string[] = [];
      for (const line of lines) {
        const shape = SHAPES.find((s) => s.pattern.test(line));
        if (shape && !(shape.name === "a gloss after a colon" && drawnByTemplate(line))) wrong.push(`${p.name}: "${line.slice(0, 80)}" explains (${shape.name})`);
        else if (EMPTY_LEAD.test(line) && wordsOf(line) > budget.emptyBudget) wrong.push(`${p.name}: "${line.slice(0, 80)}" is an empty state of ${wordsOf(line)} words`);
      }
      console.log(`${p.name}: ${lines.length} lines read, ${wrong.length} refused`);
      return wrong;
    },
  })),
};

const root = document.getElementById("root");
if (!root) throw new Error("the witness page has no #root to mount into");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Shell />
  </QueryClientProvider>,
);
