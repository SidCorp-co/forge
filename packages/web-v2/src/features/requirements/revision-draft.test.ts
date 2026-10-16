// A revision as its editor holds it and as core takes it back: a scenario's Given / When / Then steps
// read out of its body and written back so core's parse holds (`requirements/rules.ts:scenarioParses`),
// kept codes riding with their criteria, and the contracts a requirement may link read from the
// project's interface the way core checks a link.

import { describe, expect, it } from "vitest";
import { criteriaWrite, criterionDraftOf, linkableContracts, revisionDraftOf, revisionWrite, scenarioBody, scenarioOf, withForm } from "./revision-draft";

/** Core's own parse, copied as the oracle: Given, When, Then each start a line, in that order. */
const coreParses = (body: string) => {
  const starts = body.split("\n").map((l) => l.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
  const g = starts.indexOf("given");
  const w = starts.indexOf("when");
  const t = starts.indexOf("then");
  return g !== -1 && w > g && t > w;
};

describe("a scenario's steps", () => {
  it("reads each keyword's lines into its part, And continuing the part before", () => {
    expect(scenarioOf("Given a board\nAnd two cards\nWhen it is exported\nThen a sheet downloads\nBut no card moves")).toEqual({
      given: ["a board", "two cards"],
      when: ["it is exported"],
      then: ["a sheet downloads", "no card moves"],
    });
  });

  it("writes the parts back so core's parse holds, and reads back what it wrote", () => {
    const steps = { given: ["a board", "two cards"], when: ["it is exported"], then: ["a sheet downloads"] };
    const body = scenarioBody(steps);
    expect(body).toBe("Given a board\nAnd two cards\nWhen it is exported\nThen a sheet downloads");
    expect(coreParses(body)).toBe(true);
    expect(scenarioOf(body)).toEqual(steps);
  });

  it("drops blank steps and writes nothing for a part with none, which core then refuses", () => {
    const body = scenarioBody({ given: ["", "a board", "  "], when: [], then: ["a sheet"] });
    expect(body).toBe("Given a board\nThen a sheet");
    expect(coreParses(body)).toBe(false);
  });

  it("keeps a one-line scenario written before the editor under Given, the words untouched", () => {
    expect(scenarioOf("Given a board, when exported, then a sheet downloads.")).toEqual({ given: ["a board, when exported, then a sheet downloads."], when: [], then: [] });
  });

  it("reads keywords in any case and lines with no keyword into the part they follow", () => {
    expect(scenarioOf("GIVEN a\nstill a\nwhen b\nTHEN c")).toEqual({ given: ["a", "still a"], when: ["b"], then: ["c"] });
  });
});

describe("a criterion turned to the other form", () => {
  it("keeps its words: a statement becomes the Given, a scenario's lines the statement", () => {
    const s = criterionDraftOf({ code: "BC-2", body: "Staff open the page", form: "statement" });
    const sc = withForm(s, "scenario");
    expect(sc).toMatchObject({ code: "BC-2", form: "scenario", steps: { given: ["Staff open the page"], when: [], then: [] } });
    expect(withForm({ ...sc, steps: { given: ["a"], when: ["b"], then: ["c"] } }, "statement")).toMatchObject({ code: "BC-2", form: "statement", body: "Given a\nWhen b\nThen c" });
  });
});

describe("the criteria a save sends", () => {
  it("keeps each held code beside its words and form, gives an added one none, and leaves out an empty row", () => {
    const rows = [criterionDraftOf({ code: "BC-1", body: "Given a\nWhen b\nThen c", form: "scenario" }), { form: "statement" as const, body: "  The sheet names each column. ", steps: { given: [], when: [], then: [] } }, { form: "statement" as const, body: " ", steps: { given: [], when: [], then: [] } }];
    expect(criteriaWrite(rows)).toEqual([
      { code: "BC-1", body: "Given a\nWhen b\nThen c", form: "scenario" },
      { body: "The sheet names each column.", form: "statement" },
    ]);
  });

  it("sends no kind, spec or picture, so a new revision takes the head's; a blank reason goes as none; the draft's language goes back", () => {
    const draft = revisionDraftOf({ reason: "Owner asked", tldr: "Export", changeSummary: "Adds export", criteria: [{ id: "c", code: "BC-1", body: "Done", form: "statement", sinceRevision: 1, retiredRevision: 3 }] }, false);
    // a criterion live at the revision is kept even where a later one retired it
    expect(draft.criteria).toHaveLength(1);
    const body = revisionWrite({ ...draft, reason: "  " }, { writtenLang: "vi" });
    expect(body).toEqual({ reason: null, tldr: "Export", changeSummary: "Adds export", writtenLang: "vi", criteria: [{ code: "BC-1", body: "Done", form: "statement" }] });
    expect(Object.keys(body)).not.toContain("kind");
    expect(Object.keys(body)).not.toContain("spec");
  });

  it("opens a new revision with the head's criteria and none of its reason or change summary", () => {
    const head = { reason: "First", tldr: "Export", changeSummary: "Initial", criteria: [{ id: "c", code: "BC-4", body: "Done", form: "statement" as const, sinceRevision: 1, retiredRevision: null }] };
    expect(revisionDraftOf(head, true)).toEqual({ reason: "", tldr: "Export", changeSummary: "", criteria: [{ code: "BC-4", form: "statement", body: "Done", steps: { given: [], when: [], then: [] } }] });
  });
});

describe("the contracts a requirement may link", () => {
  it("names each published contract under the project's slug and each consumed one as named, once", () => {
    expect(linkableContracts({ declared: true, document: { publishes: { api: {}, events: {} }, consumes: [{ contract: "kho/api" }, { contract: "hop/api" }] } }, "hop")).toEqual(["hop/api", "hop/events", "kho/api"]);
  });

  it("offers nothing for a project with no interface", () => {
    expect(linkableContracts({ declared: false, document: null }, "hop")).toEqual([]);
  });
});
