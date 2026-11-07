import { type Said, SAID_ENTRIES, type SaidKey, type SaidKind, type SaidValue, say, sayEn, verbatim } from "@forge/contracts/said";
import { waitingOn } from "@forge/contracts/standing";
import { describe, expect, it } from "vitest";
import { PRODUCT_STRINGS as strings } from "./product-copy";
import { said, saidView, saysKey, unknownSaid } from "./said";

// What core says reaches a reader as a registry key and typed values (`@forge/contracts/said`), read
// through the product copy (English only). These hold a key's template to filling only the values the
// key declares, the English read to exactly the sentence core sends beside it, and a key this build
// lacks to a visible marker, never to English.

const EN: Record<string, string> = strings.en;
const ENTRIES = Object.entries(SAID_ENTRIES) as [SaidKey, (typeof SAID_ENTRIES)[SaidKey]][];

/** A value of each kind, as a producer would send one. */
const SAMPLE: Record<SaidKind, SaidValue> = {
  name: "Lan",
  text: "x",
  count: 2,
  version: "0.1.0",
  key: "ISS-1",
  permission: "project.write",
  role: "releases.approve",
  date: "2026-10-05",
  instant: "2026-10-05T08:00:00.000Z",
  status: "in_progress",
  statusLabel: "in_progress",
  step: "build",
  health: "ok",
  code: "CODE_X",
  agreement: "",
  said: verbatim("x"),
  "said?": null,
  saidList: [verbatim("x")],
  saidSeries: [verbatim("x")],
  saidDots: [verbatim("x")],
};

const sample = (key: SaidKey): Said => {
  const vars = Object.fromEntries(Object.entries(SAID_ENTRIES[key].vars ?? {}).map(([n, k]) => [n, SAMPLE[k]]));
  return Object.keys(vars).length ? { key, vars } : { key };
};

const slots = (template: string) => new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

describe("what core says, filled into its templates", () => {
  it("fills every value a key declares and no other, an agreement word aside", () => {
    const wrong: string[] = [];
    for (const [key, entry] of ENTRIES) {
      if (typeof EN[key] !== "string") continue;
      const declared = Object.entries(entry.vars ?? {});
      const want = new Set(declared.filter(([, k]) => k !== "agreement").map(([n]) => n));
      const all = new Set(declared.map(([n]) => n));
      const got = slots(EN[key]);
      const missing = [...want].filter((n) => !got.has(n));
      const stray = [...got].filter((n) => !all.has(n));
      if (missing.length || stray.length) wrong.push(`${key}: missing {${missing.join(",")}} stray {${stray.join(",")}}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("what core says, read in en", () => {
  it("is exactly the English core sends beside it, for every key", () => {
    const differ = ENTRIES.map(([key]) => sample(key)).filter((s) => said(s, "en") !== sayEn(s));
    expect(differ.map((s) => s.key)).toEqual([]);
  });

  it("reads a nested sentence and a list through their own keys", () => {
    const s = say("standing.effect.follow", { names: [say("standing.effect.designAt", { title: "Checkout", r: 3 }), say("standing.effect.contractAt", { contract: "orders", v: "1.2.0" })] });
    expect(said(s, "en")).toBe(sayEn(s));
    expect(said(s, "en")).toContain("Checkout revision 3, orders 1.2.0");
  });
});

describe("a key this build does not know", () => {
  const stray = { key: "standing.act.noSuchAct" } as unknown as Said;

  it("reads as a marker naming it, never as English", () => {
    expect(said(stray, "en")).toBe(unknownSaid("standing.act.noSuchAct"));
    expect(said(stray, "en")).toBe("⟦standing.act.noSuchAct⟧");
  });

  it("marks only the unknown part of a sentence that nests it", () => {
    const s = { key: "issues.rule.answered", vars: { reason: stray, who: say("standing.who.master") } } as unknown as Said;
    expect(said(s, "en")).toBe("⟦standing.act.noSuchAct⟧ Master");
  });
});

describe("a wait read from what core said", () => {
  const w = waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.triageIt"), rule: say("feedback.rule.triagerTriages", { phase: "new" }) });

  it("draws who, act and rule in the reader's words and drops what it read them from", () => {
    const v = saidView(w, "en");
    expect(v.who).toBe("You");
    expect(v.act).toBe("triage it");
    expect("says" in v).toBe(false);
    expect(saidView(w, "en")).toMatchObject({ who: "You", act: "triage it", rule: "new: a holder of feedback.approve triages it" });
  });

  it("tells which act a wait owes by its key, never by its words", () => {
    expect(saysKey(w.says.act, "standing.act.triageIt")).toBe(true);
    expect(saysKey(say("standing.acts", { acts: [say("standing.act.triageIt"), say("standing.act.ship")] }), "standing.act.triageIt")).toBe(true);
    expect(saysKey(w.says.act, "standing.act.ship")).toBe(false);
  });
});
