import { describe, expect, it } from "vitest";
import product from "./product-copy.json";
import { localizeWaiting, standingAct, standingEffect, standingRead, standingWho } from "./standing-copy";

// One sentence core really writes for each pattern: in en it is returned as core wrote it, in vi it
// is a Vietnamese sentence with the names, keys, versions and numbers carried over untouched.
const WHO = ["You", "Master", "BA or owner", "Issues", "A project admin", "A project writer", "A release approver", "The project's master", "Release run", "Release gate", "No approver", "Its author", "The revision proposal", "The linked issue", "The linked work", "The new requirement", "The current revision", "Nobody", "A holder of feedback.approve", "Its root FB-3"];
const ACT = [
  "triage 3 feedback items", "triage it again", "triage it", "triage FB-12", "accept r3", "accept the revision of REQ-4", "accept revision 2 of REQ-4", "propose the revision of REQ-4", "propose revision 2 of REQ-4",
  "revise returned r2, then propose or drop it", "revise returned r2", "propose or drop r2", "propose r2", "finish draft", "agree it", "agree r2", "propose design Staff shell", "approve design Staff shell",
  "Update to the approved design: Staff shell (revision 3)", "Update to the current version of orders-api (1.4.0)", "check BC-1, BC-2 against the traceability matrix, overdue since 2026-10-05",
  "check BC-1 against the traceability matrix, due 2026-10-09", "prove BC-3", "re-plan ISS-4, ISS-5", "break down, due 2026-10-09", "break down", "Review how this requirement is split into work",
  "promote 2 draft issues", "promote 1 draft issue", "Running 2 of 5", "Done 1 of 5", "Confirm the answer", "verify the fix shipped in 0.1.0", "verify the fix", "release ISS-7 by hand and close it",
  "release it by hand and close it", "Approve release 0.1.0", "Approve the release that carries it", "cut the release that carries ISS-7", "cut 0.1.0, then approve it", "cut 0.1.0", "cut 0.1.0 and 2 more",
  "ship", "be agreed and delivered", "be resolved", "be accepted", "be delivered", "ask for approval", "approve or return 0.1.0", "no other admin can decide", "approve", "answer the return", "deploying",
  "verifying", "starting", "declare a production environment", "declare where releases land", "cut the issues that are waiting", "bring an issue to the release gate", "split this release into smaller releases",
  "write the release note", "mark the merge", "declare a source probe on production", "pair a runner", "bring a runner online", "a release is running", "judge the criteria still owed",
  "give production a way to be read", "a check could not run", "label a runner for releases", "verdicts not re-read",
];
const EFFECT = ["Records that this requirement follows Staff shell revision 3 from now on. Its wording and criteria do not change, and its delivery is not offered for acceptance until then."];

const vi = product.vi as Record<string, string>;
const looksEnglish = (s: string) => /\b(the|and|then|it|of)\b/.test(s);

describe("the standing words, mapped by the shape of core's English", () => {
  it("keeps core's English where the language is English", () => {
    for (const w of WHO) expect(standingWho(w, "en")).toBe(w);
    for (const a of ACT) expect(standingAct(a, "en")).toBe(a);
    for (const e of EFFECT) expect(standingEffect(e, "en")).toBe(e);
  });

  it("the en copy file spells the sentence core writes: each pattern reads its sentence back unchanged", () => {
    for (const w of WHO) expect(standingRead("who", w, "en"), w).toBe(w);
    for (const a of ACT) expect(standingRead("act", a, "en"), a).toBe(a);
    for (const e of EFFECT) expect(standingRead("effect", e, "en"), e).toBe(e);
  });

  it("reads every sentence in vi, carrying names and numbers over", () => {
    for (const w of WHO) expect(standingWho(w, "vi") === w && w !== "Master", w).toBe(false);
    for (const a of ACT) {
      const vi = standingAct(a, "vi");
      expect(vi, a).not.toBe(a);
      expect(looksEnglish(vi), vi).toBe(false);
      for (const token of a.match(/\b(?:[A-Z]{2,}-\d+|r\d+|\d+\.\d+\.\d+|BC-\d)\b/g) ?? []) expect(vi, `${a} -> ${vi}`).toContain(token);
    }
    expect(standingEffect(EFFECT[0] as string, "vi")).toContain("Staff shell revision 3");
  });

  it("reads several joined acts one by one, and leaves a sentence it does not know as core wrote it", () => {
    expect(standingAct("Update to the approved design: A (revision 2); Update to the current version of c (1.0.0)", "vi")).toBe(
      `${standingAct("Update to the approved design: A (revision 2)", "vi")}; ${standingAct("Update to the current version of c (1.0.0)", "vi")}`,
    );
    expect(standingAct("juggle the flaming pins", "vi")).toBe("juggle the flaming pins");
    expect(standingWho("Minh", "vi")).toBe("Minh");
  });

  it("localizes a whole waiting-on and leaves its rule and kind", () => {
    const w = { kind: "you", who: "You", act: "cut 0.1.0", rule: "an admin cuts the version", ref: null, dueAt: null };
    expect(localizeWaiting(w, "vi")).toMatchObject({ kind: "you", rule: w.rule, who: vi["standing.who.you"], act: (vi["standing.act.cut"] as string).replace("{v}", "0.1.0").replace("{more}", "") });
    expect(localizeWaiting(w, "en")).toBe(w);
  });
});
