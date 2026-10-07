import { type Said, SAID_ENTRIES, type SaidKey, type SaidKind, type SaidValue, say, sayEn, verbatim } from "@forge/contracts/said";
import { waitingOn } from "@forge/contracts/standing";
import { describe, expect, it } from "vitest";
import { englishChromeWord } from "@/test/english-chrome";
import strings from "./product-copy.json";
import { said, saidView, saysKey, unknownSaid } from "./said";

// What core says reaches a reader as a registry key and typed values (`@forge/contracts/said`), read
// through the product copy of the reader's language. These hold every key to a vi template that fills
// only the values the key declares, the English read to exactly the sentence core sends beside it, and
// a key this build lacks to a visible marker, never to English.

const VI = strings.vi as Record<string, string>;
const ENTRIES = Object.entries(SAID_ENTRIES) as [SaidKey, (typeof SAID_ENTRIES)[SaidKey]][];

/** A value of each kind, as a producer would send one. */
const SAMPLE: Record<SaidKind, SaidValue> = {
  name: "Lan",
  text: "x",
  count: 2,
  version: "0.1.0",
  key: "ISS-1",
  permission: "project.write",
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
  const vars = Object.fromEntries(Object.entries(SAID_ENTRIES[key].vars ?? {}).map(([n, k]) => [n, SAMPLE[k as SaidKind]]));
  return Object.keys(vars).length ? { key, vars } : { key };
};

const slots = (template: string) => new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string));

describe("what core says, read in vi", () => {
  it("has a vi template for every key core can say", () => {
    expect(ENTRIES.filter(([k]) => typeof VI[k] !== "string").map(([k]) => k)).toEqual([]);
  });

  it("fills every value a key declares and no other, an English agreement word aside", () => {
    const wrong: string[] = [];
    for (const [key, entry] of ENTRIES) {
      const declared = Object.entries(entry.vars ?? {});
      const want = new Set(declared.filter(([, k]) => k !== "agreement").map(([n]) => n));
      const all = new Set(declared.map(([n]) => n));
      const got = slots(VI[key] ?? "");
      const missing = [...want].filter((n) => !got.has(n));
      const stray = [...got].filter((n) => !all.has(n));
      if (missing.length || stray.length) wrong.push(`${key}: missing {${missing.join(",")}} stray {${stray.join(",")}}`);
    }
    expect(wrong).toEqual([]);
  });

  it("holds no English chrome word in any key's vi sentence", () => {
    const english = ENTRIES.map(([key]) => [key, said(sample(key), "vi")] as const)
      .map(([key, text]) => [key, englishChromeWord(text), text] as const)
      .filter(([, word]) => word !== null);
    expect(english).toEqual([]);
  });

  it("reads the session a run closed short of an outcome in vi, not as core's English (live QA, run detail)", () => {
    const s = say("runs.final.shortOf", {
      close: say("runs.final.close", { close: "ended" }),
      missed: [say("runs.final.missed", { key: "ISS-110", status: "needs_info", landed: null })],
    });
    expect(sayEn(s)).toBe("the session closed (ended) with ISS-110 at needs_info, short of an outcome");
    const vi = said(s, "vi");
    expect(vi).toContain("ISS-110");
    expect(vi).not.toContain("short of an outcome");
    expect(vi).not.toContain("the session closed");
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

  it("reads as a marker naming it, in every language, never as English", () => {
    expect(said(stray, "vi")).toBe(unknownSaid("standing.act.noSuchAct"));
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
    const v = saidView(w, "vi");
    expect(v.who).toBe(VI["standing.who.you"]);
    expect(v.act).toBe(VI["standing.act.triageIt"]);
    expect("says" in v).toBe(false);
    expect(saidView(w, "en")).toMatchObject({ who: "You", act: "triage it", rule: "new: a holder of feedback.approve triages it" });
  });

  it("tells which act a wait owes by its key, never by its words", () => {
    expect(saysKey(w.says.act, "standing.act.triageIt")).toBe(true);
    expect(saysKey(say("standing.acts", { acts: [say("standing.act.triageIt"), say("standing.act.ship")] }), "standing.act.triageIt")).toBe(true);
    expect(saysKey(w.says.act, "standing.act.ship")).toBe(false);
  });
});
