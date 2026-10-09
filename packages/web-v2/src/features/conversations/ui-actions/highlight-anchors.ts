// Where each section `ui.highlight` names sits on its record's page (REQ-41 BC-6), and the tab that
// shows it: one table, so the contract's sections (`UI_HIGHLIGHT_SECTIONS`) and the pages' elements
// are matched in one place. An anchor is an element the page already draws, found by the attribute it
// already carries, or by `data-highlight` where it carried none; nothing is wrapped or moved for it.

import type { UiHighlight, UiHighlightSection, UiPageItemKind } from "@forge/contracts/ui-actions";

export interface HighlightAnchor {
  /** Tried in order; the first on the page is marked. */
  selectors: readonly string[];
  /** The `?tab=` the record's page shows it under; null where it shows on every tab. */
  tab: string | null;
}

const anchor = (tab: string | null, ...selectors: string[]): HighlightAnchor => ({ selectors, tab });

/** Every section the contract names, per record page. A section with no anchor has no element yet. */
export const HIGHLIGHT_ANCHORS: { [K in UiPageItemKind]?: Partial<Record<UiHighlightSection, HighlightAnchor>> } = {
  requirement: {
    waiting: anchor(null, '[data-testid="requirement-progress"] [data-testid="wait-banner"]', '[data-testid="requirement-progress"]'),
    question: anchor("overview", '[data-testid="requirement-unclear"]'),
    criteria: anchor("criteria", '[data-testid="view-criteria"]'),
    picture: anchor(null, '[data-testid="requirement-picture"]'),
    delivery: anchor(null, '[data-testid="requirement-progress"]'),
    history: anchor("activity", '[data-testid="view-activity"]'),
  },
  feedback: {
    waiting: anchor(null, '[data-testid="feedback-detail"] [data-testid="wait-banner"]'),
    question: anchor(null, '[data-testid="feedback-detail"] [data-testid="wait-banner"]'),
    evidence: anchor("overview", '[data-highlight~="evidence"]'),
    triage: anchor("overview", '[data-highlight~="triage"]'),
    route: anchor(null, '[data-testid="facts-route"]'),
    verify: anchor("overview", '[data-highlight~="verify"]'),
  },
  issue: {
    waiting: anchor(null, '[data-highlight~="waiting"]'),
    question: anchor(null, '[data-highlight~="question"]'),
    criteria: anchor("criteria", '[data-testid="view-criteria"]'),
    plan: anchor("overview", '[data-highlight~="plan"]'),
    preview: anchor("overview", '[data-highlight~="preview"]'),
  },
};

/** A workflow step is drawn as a row of the design's Steps tab. */
export const STEP_TAB = "steps";

const quote = (v: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&"));

/** The selectors a highlight is found by on a page about `kind` (none for a section the page lacks). */
export function selectorsOf(h: UiHighlight, kind: UiPageItemKind | null): readonly string[] {
  if (h.target === "row") {
    const k = quote(h.key ?? "");
    return [`[data-testid="list-row"][data-key="${k}"]`, `[data-row-key="${k}"]`, `[data-testid="workflow-row"][data-flow="${k}"]`];
  }
  if (h.target === "step") return [`[data-testid="design-step-row"][data-step="${quote(h.step ?? "")}"]`];
  const a = kind && h.section ? HIGHLIGHT_ANCHORS[kind]?.[h.section] : undefined;
  return a?.selectors ?? [];
}

/** The tab a highlight's element shows under, or null. */
export function tabOf(h: UiHighlight, kind: UiPageItemKind | null): string | null {
  if (h.target === "step") return STEP_TAB;
  if (h.target === "row" || !kind || !h.section) return null;
  return HIGHLIGHT_ANCHORS[kind]?.[h.section]?.tab ?? null;
}

/** The first element on the page a highlight names, or null. */
export function findHighlighted(selectors: readonly string[], root: ParentNode = document): Element | null {
  for (const s of selectors) {
    const el = root.querySelector(s);
    if (el) return el;
  }
  return null;
}
