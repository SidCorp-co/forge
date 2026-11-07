// What the Agreements page draws from core's answer, as pure functions: the groups the rows read in,
// the narrowing by search and state, and a run's received agreements set against the current ones.

import {
  AGREEMENT_STATES,
  type AgreementCondition,
  type AgreementState,
  type AgreementView,
  parseAgreementRevision,
} from "@forge/contracts/agreements";
import type { RunContextView } from "@forge/contracts/run-context";
import type { LegendTone, ListGroup } from "@/design";
import type { Copy } from "@/lib/i18n/product-copy";

/** The state filter's values: core's four states, and the locked guarantees. */
export const STATE_FILTERS = [...AGREEMENT_STATES, "locked"] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

export const STATE_TONE: Record<AgreementState, LegendTone> = {
  inherited: "neutral",
  overridden: "run",
  project_only: "ready",
  conflict: "you",
};

export function searchText(a: AgreementView): string {
  return [a.name, a.effective.rule, a.forge?.rule, a.project?.rule].filter(Boolean).join(" ");
}

/** Whether a row stands under the `?state=` filter: a state of core's, or `locked`. */
export function inState(a: AgreementView, state: string | null): boolean {
  if (!state) return true;
  if (state === "locked") return a.locked;
  return a.state === state;
}

/**
 * The current rules in three groups: what the project changed (conflicts first), what it inherits, and
 * the locked guarantees. While the project has changes, the inherited defaults and the guarantees are
 * one click away, so the changes and what agents get from them read first.
 */
export function currentGroups(rows: AgreementView[], t: Copy): ListGroup<AgreementView>[] {
  const order: Record<AgreementState, number> = { conflict: 0, overridden: 1, project_only: 2, inherited: 3 };
  const changed = rows.filter((a) => !a.locked && a.state !== "inherited").sort((x, y) => order[x.state] - order[y.state]);
  const inherited = rows.filter((a) => !a.locked && a.state === "inherited");
  const locked = rows.filter((a) => a.locked);
  return [
    { id: "changed", label: t("agreements.group.changed"), tone: changed.some((a) => a.state === "conflict") ? "you" : "run", rows: changed },
    { id: "inherited", label: t("agreements.group.inherited"), tone: "neutral", rows: inherited, collapsed: changed.length > 0 },
    { id: "locked", label: t("agreements.group.locked"), tone: "blocked", rows: locked, collapsed: true },
  ].filter((g) => g.rows.length > 0) as ListGroup<AgreementView>[];
}

/** One agreement as a run received it: the revision it was given, against the one in force now. */
export interface ReceivedRow {
  agreement: AgreementView;
  received: string;
  layer: "forge" | "project" | "config";
  now: "same" | "changed" | "retired";
}

/** A received agreement no longer in force: named from its slug, the only name the record holds. */
function retired(slug: string, revision: string): AgreementView {
  const name = slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  return {
    slug,
    name,
    locked: false,
    authority: "agreement",
    door: null,
    state: "project_only",
    forge: null,
    project: null,
    effective: { rule: "", detail: null, condition: null, from: "project", revision },
    conflict: null,
    applies: null,
  };
}

/** A run's agreements, the last revision of each it was given, and every current one it was not given. */
export function receivedOf(rows: AgreementView[], context: RunContextView): { received: ReceivedRow[]; missing: AgreementView[] } {
  const last = new Map<string, string>();
  for (const r of context.reached) if (r.kind === "agreement" && r.revision && parseAgreementRevision(r.revision)) last.set(r.ref, r.revision);
  const bySlug = new Map(rows.map((a) => [a.slug, a]));
  const received: ReceivedRow[] = [...last].map(([slug, revision]) => {
    const current = bySlug.get(slug);
    const layer = parseAgreementRevision(revision)?.layer ?? "forge";
    if (!current) return { agreement: retired(slug, revision), received: revision, layer, now: "retired" };
    return { agreement: current, received: revision, layer, now: current.effective.revision === revision ? "same" : "changed" };
  });
  return { received, missing: rows.filter((a) => !last.has(a.slug)) };
}

/** A condition as the labels and categories it names, or null where the agreement always applies. */
export function conditionWords(c: AgreementCondition | null): string | null {
  if (!c) return null;
  return [...(c.labels ?? []), ...(c.categories ?? [])].join(", ");
}

/** A comma list typed into a field, as the condition's values: blanks dropped. */
export function listOf(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
