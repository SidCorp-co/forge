import { describe, expect, it } from "vitest";
import product from "./product-copy.json";
import { feedbackNote, historyText, historyWho, localizeWaiting, STANDING_RULES, standingAct, standingEffect, standingRead, standingWho } from "./standing-copy";

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

const FEEDBACK_NOTE = [
  "The reporter has turned this notice off, so it reached nobody: tell them yourself.",
  "The reporter is an agent, which has no bell: tell it where it listens.",
  "It shipped before Forge told reporters when a release shipped.",
  "0.2.0 shipped it and sent the reporter no notice.",
  "No release carries it, so none told the reporter: tell them yourself.",
  "Verified automatically after 14 days with no reply",
  "triage without dedup: the item's vector is pending",
];

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
    for (const n of FEEDBACK_NOTE) expect(standingRead("feedbackNote", n, "en"), n).toBe(n);
  });

  it("reads a feedback item's own core sentences in vi, carrying the version and the days over", () => {
    for (const n of FEEDBACK_NOTE) {
      expect(feedbackNote(n, "en")).toBe(n);
      const read = feedbackNote(n, "vi");
      expect(read, n).not.toBe(n);
      expect(looksEnglish(read), read).toBe(false);
    }
    expect(feedbackNote("0.2.0 shipped it and sent the reporter no notice.", "vi")).toContain("0.2.0");
    expect(feedbackNote("Verified automatically after 14 days with no reply", "vi")).toContain("14");
    expect(feedbackNote("a reason a person wrote", "vi")).toBe("a reason a person wrote");
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

// One record per pattern `requirements/history-read.ts` writes; what a person typed after the colon is
// carried over as written.
const HISTORY = [
  "Wrote r2: Tighten the totals", "Wrote r3 (an accepted suggestion): Tighten the totals", "Proposed r2", "Accepted r2", "Accepted r2: the BA agreed",
  "Returned r2: unclear scope", "Deferred out of the current release (for Q4): waits on finance", "Deferred out of the current release: waits on finance",
  "Undeferred", "Undeferred: finance is ready", "Agreed r1", "Agreed r1: signed off in the review", "Re-pinned r1 onto the approved designs",
  "Re-pinned r1 onto the approved designs: checkout moved", "Accepted the delivery", "Accepted the delivery: all good", "Dropped: not needed",
  "Suggested a revision", "Suggested a readiness check", "Accepted a breakdown", "Accepted a breakdown: fine", "Rejected a duplicate", "Rejected a change: too broad",
];
const HISTORY_WHO = ["Someone", "A signer", "An agent", "BA assistant"];

describe("a requirement's history, mapped by the shape of core's record", () => {
  it("reads each record back unchanged in en, and as written where the language is English", () => {
    for (const h of HISTORY) {
      expect(standingRead("history", h, "en"), h).toBe(h);
      expect(historyText(h, "en")).toBe(h);
    }
    for (const w of HISTORY_WHO) expect(standingRead("historyWho", w, "en"), w).toBe(w);
  });

  it("reads each record in vi, keeping the revision and what the person wrote", () => {
    for (const h of HISTORY) {
      const read = historyText(h, "vi");
      expect(read, h).not.toBe(h);
      for (const token of h.match(/\br\d+\b/g) ?? []) expect(read, `${h} -> ${read}`).toContain(token);
      const typed = h.split(": ")[1];
      if (typed) expect(read, `${h} -> ${read}`).toContain(typed);
    }
    for (const w of HISTORY_WHO) expect(historyWho(w, "vi"), w).not.toBe(w);
    expect(historyWho("Lan", "vi")).toBe("Lan");
    expect(historyWho("You", "vi")).toBe(vi["standing.who.you"]);
  });

  it("leaves a record it does not know as core wrote it", () => {
    expect(historyText("Re-pinned r1 onto the approved designs (ready)", "vi")).toBe("Re-pinned r1 onto the approved designs (ready)");
    expect(historyText("", "vi")).toBe("");
  });

  it("holds one sentence to every feedback note pattern", () => {
    for (const rule of STANDING_RULES.feedbackNote) expect(FEEDBACK_NOTE.some((n) => rule.re.test(n)), String(rule.re)).toBe(true);
  });

  it("holds one record to every history pattern", () => {
    for (const rule of STANDING_RULES.history) expect(HISTORY.some((h) => rule.re.test(h)), String(rule.re)).toBe(true);
  });
});
