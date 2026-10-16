// A revision as its editor holds it: the reason, summary and change summary, and each criterion as a
// statement or as the steps of a scenario. Core keeps a scenario as one body whose lines start
// Given, When and Then, in that order (`requirements/rules.ts:scenarioParses`); the editor reads that
// body into its three parts and writes it back the same way, so the keywords stay English whatever
// language the page reads in. Whether a body parses is core's to say: a part left empty goes as
// written and comes back refused on its criterion.

import type { ProjectInterfaceRead, RequirementCriterion, RequirementRevision } from "./types";

export const SCENARIO_PARTS = ["given", "when", "then"] as const;
export type ScenarioPart = (typeof SCENARIO_PARTS)[number];
export type ScenarioSteps = Record<ScenarioPart, string[]>;

const KEYWORD: Record<ScenarioPart, string> = { given: "Given", when: "When", then: "Then" };
const CONTINUES = new Set(["and", "but"]);

export interface CriterionDraft {
  /** The code it keeps; absent on a criterion this editor added, which core numbers on save. */
  code?: string;
  form: RequirementCriterion["form"];
  /** A statement's words. */
  body: string;
  /** A scenario's steps, one line each, without their keyword. */
  steps: ScenarioSteps;
}

export interface RevisionDraft {
  reason: string;
  tldr: string;
  changeSummary: string;
  criteria: CriterionDraft[];
}

const noSteps = (): ScenarioSteps => ({ given: [], when: [], then: [] });

/** A scenario body read into its parts: a line's first word names its part, And and But continue the one before. */
export function scenarioOf(body: string): ScenarioSteps {
  const steps = noSteps();
  let part: ScenarioPart = "given";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [first = "", ...rest] = line.split(/\s+/);
    const word = first.toLowerCase();
    if ((SCENARIO_PARTS as readonly string[]).includes(word)) part = word as ScenarioPart;
    else if (!CONTINUES.has(word)) {
      steps[part].push(line);
      continue;
    }
    const text = rest.join(" ");
    if (text) steps[part].push(text);
  }
  return steps;
}

/** The parts written back as core reads a scenario: each part's first step under its keyword, the rest under And. */
export function scenarioBody(steps: ScenarioSteps): string {
  return SCENARIO_PARTS.flatMap((part) =>
    steps[part]
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s, i) => `${i === 0 ? KEYWORD[part] : "And"} ${s}`),
  ).join("\n");
}

/** One held criterion as its editor row. */
export function criterionDraftOf(c: Pick<RequirementCriterion, "code" | "body" | "form">): CriterionDraft {
  return c.form === "scenario" ? { code: c.code, form: "scenario", body: "", steps: scenarioOf(c.body) } : { code: c.code, form: "statement", body: c.body, steps: noSteps() };
}

export const blankCriterion = (form: CriterionDraft["form"] = "statement"): CriterionDraft => ({ form, body: "", steps: noSteps() });

/** A row turned to the other form, keeping its words: a statement's words become the Given, a scenario's lines the statement. */
export function withForm(c: CriterionDraft, form: CriterionDraft["form"]): CriterionDraft {
  if (c.form === form) return c;
  if (form === "scenario") return { ...c, form, steps: c.body.trim() ? scenarioOf(c.body) : noSteps(), body: "" };
  return { ...c, form, body: scenarioBody(c.steps), steps: noSteps() };
}

const bodyOf = (c: CriterionDraft) => (c.form === "scenario" ? scenarioBody(c.steps) : c.body.trim());

/** What the editor opens on: a draft as held, or a new revision starting from the head's criteria (those live at it). */
export function revisionDraftOf(from: Pick<RequirementRevision, "reason" | "tldr" | "changeSummary" | "criteria"> | null, fresh: boolean): RevisionDraft {
  return {
    reason: fresh ? "" : (from?.reason ?? ""),
    tldr: from?.tldr ?? "",
    changeSummary: fresh ? "" : (from?.changeSummary ?? ""),
    criteria: (from?.criteria ?? []).map(criterionDraftOf),
  };
}

/** The criteria as core takes them: every row with words, a kept code beside its body and form. */
export function criteriaWrite(rows: readonly CriterionDraft[]): { code?: string; body: string; form: CriterionDraft["form"] }[] {
  return rows.flatMap((c) => {
    const body = bodyOf(c);
    if (!body) return [];
    return [{ ...(c.code ? { code: c.code } : {}), body, form: c.form }];
  });
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

/**
 * The body a revision write sends. Its kind, spec and picture are left out, so a new revision takes
 * the head's and an edit keeps the draft's; the language it was written in goes back as held.
 */
export function revisionWrite(draft: RevisionDraft, held: Pick<RequirementRevision, "writtenLang"> | null) {
  return {
    reason: orNull(draft.reason),
    tldr: orNull(draft.tldr),
    changeSummary: orNull(draft.changeSummary),
    ...(held?.writtenLang ? { writtenLang: held.writtenLang } : {}),
    criteria: criteriaWrite(draft.criteria),
  };
}

/** Whether a row holds any words; a save with none would be refused as empty. */
export const criterionHasWords = (c: CriterionDraft) => bodyOf(c).length > 0;

/**
 * The contracts a requirement may link, as core's link checks them (`ecosystem/interface-contracts.ts`):
 * each contract the project publishes, under the project's own slug, then each it consumes as named.
 */
export function linkableContracts(read: ProjectInterfaceRead, projectSlug: string): string[] {
  const doc = read.document;
  if (!doc) return [];
  return [...new Set([...Object.keys(doc.publishes).map((slug) => `${projectSlug}/${slug}`), ...doc.consumes.map((c) => c.contract)])];
}
