import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import product from "./product-copy.json";
import { GATE_SENTENCES, RISK_SENTENCES } from "@/test/vi-chrome-shared";
import { blockerText, feedbackNote, gateSentence, gateTitle, historyText, historyWho, localizeWaiting, riskSentence, STANDING_RULES, standingAct, standingEffect, standingRead, standingRule, standingWho } from "./standing-copy";

// One sentence core really writes for each pattern: in en it is returned as core wrote it, in vi it
// is a Vietnamese sentence with the names, keys, versions and numbers carried over untouched.
const WHO = ["You", "Master", "BA or owner", "Issues", "A project admin", "A project writer", "A release approver", "The project's master", "Release run", "Release gate", "No approver", "Its author", "The revision proposal", "The linked issue", "The linked work", "The new requirement", "The current revision", "Nobody", "A holder of feedback.approve", "Its root FB-3", "Run", "Queued run", "Next run", "Release", "No holder", "A design approver", "The contract provider"];
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
  "answer a question", "make a decision", "supply what it asks for", "resume it", "resume once: ISS-9 lands", "take on or drop", "shipped", "dropped", "working",
  "Build · 12 min", "Test", "design approval", "landed, waits on a judge", "landed · claim it and judge what landed", "running", "needs a person", "paused", "came back",
  "not started", "declare the policy", "declare its policy state", "approve the design", "approve a contract version", "in progress with no live run", "re-run after reopen",
  "build next", "dispatch a run", "revise design Staff shell · revision 3 returned", "judge it again", "Approve release on Releases", "next release", "wait on ISS-4",
  "read the answer", "read the answer back", "answer the other question", "move it on", "move it on: TRANSITION_REFUSED",
];
const EFFECT = [
  "Records that this requirement follows Staff shell revision 3 from now on. Its wording and criteria do not change, and its delivery is not offered for acceptance until then.",
  "Cuts the oldest 50 merged issues as this release and leaves the other 13 at the release gate for the next one.",
  "Cuts the oldest 50 merged issues as this release and leaves the others at the release gate for the next one.",
];

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
    // Master and Release are product words the vi copy keeps
    for (const w of WHO) expect(standingWho(w, "vi") === w && w !== "Master" && w !== "Release", w).toBe(false);
    for (const a of ACT) {
      const vi = standingAct(a, "vi");
      expect(vi, a).not.toBe(a);
      expect(looksEnglish(vi), vi).toBe(false);
      for (const token of a.match(/\b(?:[A-Z]{2,}-\d+|r\d+|\d+\.\d+\.\d+|BC-\d)\b/g) ?? []) expect(vi, `${a} -> ${vi}`).toContain(token);
    }
    expect(standingEffect(EFFECT[0] as string, "vi")).toContain("Staff shell revision 3");
    for (const e of EFFECT.slice(1)) {
      const vi = standingEffect(e, "vi");
      expect(vi, e).not.toBe(e);
      expect(looksEnglish(vi), vi).toBe(false);
      expect(vi).toContain("50");
    }
    expect(standingEffect(EFFECT[1] as string, "vi")).toContain("13");
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

// Core's release-gate titles and sentences and its data-risk sentences (`release-batch/release-gates.ts`,
// `landing-surfaces.ts`), one real sentence per reading shape, kept beside the walking test's fixture.
describe("a release gate's words, mapped by the shape of core's English", () => {
  const titles = [...new Set(GATE_SENTENCES.map((g) => g.title))];
  const sentences = GATE_SENTENCES.map((g) => g.sentence);
  const risks = RISK_SENTENCES.map((r) => r.sentence);

  it("the en copy file spells every title and sentence as core writes it", () => {
    for (const t of titles) expect(standingRead("gateTitle", t, "en"), t).toBe(t);
    for (const s of sentences) expect(standingRead("gateSentence", s, "en"), s).toBe(s);
    for (const r of risks) expect(standingRead("risk", r, "en"), r).toBe(r);
    for (const g of GATE_SENTENCES) expect(standingRead("act", g.act, "en"), g.act).toBe(g.act);
  });

  it("holds a pattern to every title core gives a gate: seventeen readings, each its own words", () => {
    expect(titles).toHaveLength(17);
    expect(STANDING_RULES.gateTitle).toHaveLength(17);
    const vis = titles.map((t) => gateTitle(t, "vi"));
    expect(new Set(vis).size).toBe(titles.length);
  });

  it("reads each in vi, carrying the keys, counts and limits over untouched", () => {
    for (const s of [...titles.map((t) => gateTitle(t, "vi")), ...sentences.map((s) => gateSentence(s, "vi")), ...risks.map((r) => riskSentence(r, "vi"))]) {
      expect(looksEnglish(s), s).toBe(false);
    }
    expect(gateSentence("ISS-6, ISS-7, ISS-8, ISS-9, ISS-10 and 2 more have no release note, so the release would claim a ship nobody described.", "vi")).toMatch(/^ISS-6, ISS-7, ISS-8, ISS-9, ISS-10 .*2/);
    expect(gateSentence("63 issues are waiting, and one release carries at most 50. Split them into smaller releases, oldest merge first.", "vi")).toMatch(/63.*50/);
    expect(gateSentence("ISS-4 owes criteria 1, 2; ISS-5 owes criterion 3. The unattended sweep carries an issue only when every criterion holds a passing verdict.", "vi")).toMatch(/ISS-4 .*1, 2; ISS-5 .*3\./);
    expect(riskSentence("GET /v1/orders is removed: a caller still using it is refused after this ships", "vi")).toMatch(/^GET \/v1\/orders /);
    expect(standingAct("write the release note on ISS-6 and 2 more", "vi")).not.toMatch(/\bon\b|\bmore\b/);
  });

  it("leaves a sentence it does not know, or one naming a part it does not know, as core wrote it", () => {
    expect(gateSentence("A gate core added later says this.", "vi")).toBe("A gate core added later says this.");
    expect(gateTitle("A new reading", "vi")).toBe("A new reading");
    const odd = "Someone else entirely has no release note, so the release would claim a ship nobody described.";
    expect(gateSentence(odd, "vi")).toBe(odd);
    expect(standingAct("write the release note on the docs team", "vi")).toBe("write the release note on the docs team");
  });
});

// Why an issue is not moving (core `issues/standing-blocker.ts`, `answered-wait.ts`), its queued
// step's gate and a paused run (`pipeline-health-reasons.ts`): every plain sentence core writes there
// is read off core's own source, so a sentence core rewords and the copy file does not is red here.
describe("an issue's blocker, mapped by the shape of core's English", () => {
  const core = (file: string) => readFileSync(resolve(__dirname, "../../../../core/src/issues", file), "utf8");
  const literals = (src: string) =>
    [...src.matchAll(/(?:reason|who|detail|label|short):\s*\n?\s*'((?:[^'\\]|\\.)+)'/g)].map((m) => (m[1] as string).replace(/\\'/g, "'"));
  const RESUME_IT = "Resume it from the status menu once it can go on.";
  const plain = [
    ...literals(core("standing-blocker.ts")),
    // a paused run's own detail is never shown alone: core always says what holds it after it (the built sentences below)
    ...literals(core("pipeline-health-reasons.ts")).filter((s) => !GATE_SHORT.has(s) && !s.startsWith("The pipeline run for this issue is paused")),
    ...literals(core("answered-wait.ts")),
    `A person names where it goes. ${RESUME_IT}`,
    `A person resumes it where it stopped. ${RESUME_IT}`,
    `A person resumes it once that wait is over. ${RESUME_IT}`,
    `Clear what the refusal names, then move it on. ${RESUME_IT}`,
  ];
  const built = [
    "Resume at Needs info",
    "Blocked by ISS-4, which delivers a design not yet approved: Staff shell revision 3.",
    "Blocked by ISS-4, ISS-5, which deliver designs not yet approved: Staff shell revision 3; Login revision 2.",
    "The design approver decides the revision ISS-4 delivers; this issue is released once it is approved.",
    "Blocked by ISS-4, which has landed and waits on a judge.",
    "Blocked by ISS-4, ISS-5, which have landed and wait on a judge.",
    "A judge records a verdict on each criterion of ISS-4; this issue is released once it passes.",
    "A judge records a verdict on each criterion of ISS-4, ISS-5; this issue is released once they pass.",
    "Blocked by 1 open issue.",
    "Blocked by 3 open issues.",
    "ISS-4 settles first; its blocks edge holds this issue until then.",
    "Its question was answered, and the answer went to the run that asked (session 9f2c1a).",
    "Its question was answered, and another question on it is still open (q1, q2).",
    "The pipeline run for this issue is paused. No step will dispatch while it is, whatever this issue's status says. It is held by stage stalled at build.",
    "The pipeline run for this issue is paused, waiting for the condition that paused it to clear. An operator paused it.",
  ];

  it("reads core's source: it still writes the sentences this test holds", () => {
    expect(plain.length).toBeGreaterThanOrEqual(40);
  });

  it("the en copy file spells every sentence as core writes it", () => {
    for (const s of [...plain, ...built]) expect(standingRead("blocker", s, "en"), s).toBe(s);
  });

  it("reads each in vi, carrying keys and session ids over", () => {
    for (const s of [...plain, ...built]) {
      const read = blockerText(s, "vi");
      expect(read, s).not.toBe(s);
      for (const token of s.match(/\bISS-\d+\b|\b9f2c1a\b/g) ?? []) expect(read, s).toContain(token);
    }
  });

  it("leaves a sentence it does not know as core wrote it", () => {
    expect(blockerText("A blocker core added later.", "vi")).toBe("A blocker core added later.");
    expect(blockerText("Resume at Somewhere new", "vi")).toBe("Resume at Somewhere new");
  });
});

describe("why an issue waits where it does (a turn's rule), mapped by the shape of core's English", () => {
  const src = ["standing.ts", "standing-release.ts", "strand-rules.ts"].map((f) => readFileSync(resolve(__dirname, "../../../../core/src/issues", f), "utf8")).join("\n");
  // each sentence as core builds it, with the fixed pieces of core's template it is built from
  const RULES: [string, string[]][] = [
    ["a run parked it on_hold and asked a question only a person can answer: the tenant must confirm", ["a run parked it on_hold and asked a question only a person can answer: "]],
    ["a run parked it on_hold behind ISS-4, which still holds it: the run named no reason", ["a run parked it on_hold behind ", ", which still holds it: ", "the run named no reason"]],
    ["a run parked it on_hold: wait for the vendor; the master resumes it once that clears", ["a run parked it on_hold: ", "; the master resumes it once that clears"]],
    ["the issue is closed", ["the issue is "]],
    ["the issue is dropped", ["the issue is "]],
    ["a person paused it; a person resumes it", ["a person paused it; a person resumes it"]],
    ["parked at needs_info: a person owes the answer; it wakes the master", ["parked at needs_info: a person owes the answer; it wakes the master"]],
    ["a run asked a question only a person can answer", ["a run asked a question only a person can answer"]],
    ["a draft is not work until a person accepts it", ["a draft is not work until a person accepts it"]],
    ["lease held by box-1", ["lease held by "]],
    ["lease held by a run session that has not ended", ["lease held by ", "a run session that has not ended"]],
    ["a job is queued on it and no run session holds it yet", ["a job is queued on it and no run session holds it yet"]],
    ["a live blocks edge from ISS-4, which delivers a design: Staff shell revision 3; it settles once that revision is approved", ["a live blocks edge from ", ", which delivers a design: ", "; it settles once that revision is approved"]],
    ["a live blocks edge from ISS-4, which has landed and is not settled until a judge passes every criterion", [", which has landed and is not settled until a judge passes every criterion"]],
    ["a live blocks edge from ISS-4, not yet settled", [", not yet settled"]],
    ["POLICY_UNDECLARED: the project declares no data policy. No master is handed it until then.", [" No master is handed it until then."]],
    ["in_progress, but no lease is live and no job or run is in flight", ["in_progress, but no lease is live and no job or run is in flight"]],
    ["sent back with a reason; a master takes it again", ["sent back with a reason; a master takes it again"]],
    ["the plan checkpoint holds; the next run goes straight to build", ["the plan checkpoint holds; the next run goes straight to build"]],
    [
      "admitted and nothing withholds it, so the project's master owes it a run; reading whether it is real is the first thing that master's pass does with it, not a gate before it",
      ["admitted and nothing withholds it, so the project's master owes it a run; reading whether it is real is the first thing that master's pass does with it, not a gate before it"],
    ],
    [
      "its approver returned design login revision 2, drawn under this issue: what it owes is the revised design, which a run writes and proposes again, not a judgement of what landed",
      ["its approver returned design ", ", drawn under this issue: what it owes is the revised design, which a run writes and proposes again, not a judgement of what landed"],
    ],
    [
      "the change landed and the issue stands at `open`: the run that claims it next judges what landed and moves it to `awaiting_release` rather than building it",
      ["the change landed and the issue stands at \\`", "\\`: the run that claims it next judges what landed and moves it to \\`awaiting_release\\` rather than building it"],
    ],
    [
      "2 of 5 criteria have no verdict that passes now, such as one judged on a storefront draft the source has moved past or cannot read back; the release hold keeps it until a run judges them again",
      [" criteria have no verdict that passes now, such as one judged on a storefront draft the source has moved past or cannot read back; the release hold keeps it until a run judges them again"],
    ],
    [
      "no release note: a release refuses to carry an issue without one (RELEASE_RECORD_MISSING), and writing it is the master's act, which it is told on its next pass",
      ["no release note: a release refuses to carry an issue without one (RELEASE_RECORD_MISSING), and writing it is the master's act, which it is told on its next pass"],
    ],
    [
      "every criterion passed; this project requires a person to approve each release, once per release on Releases (Cut the version, then Approve release), never once per issue",
      ["every criterion passed; this project requires a person to approve each release, once per release on Releases (Cut the version, then Approve release), never once per issue"],
    ],
    ["a release run holds it", ["a release run holds it"]],
    ["every criterion passed; the project releases without an approval", ["every criterion passed; the project releases without an approval"]],
  ];

  it("reads core's source: it still builds each sentence from these pieces", () => {
    for (const [sentence, pieces] of RULES) for (const piece of pieces) expect(src.includes(piece), `${piece} (of: ${sentence})`).toBe(true);
  });

  it("the en copy file spells every sentence as core writes it", () => {
    for (const [s] of RULES) expect(standingRead("rule", s, "en"), s).toBe(s);
  });

  it("reads each in vi, carrying keys, codes and a run's own words over", () => {
    for (const [s] of RULES) {
      const read = standingRule(s, "vi");
      expect(read, s).not.toBe(s);
      for (const token of s.match(/\bISS-\d+\b|\bbox-1\b|POLICY_UNDECLARED|RELEASE_RECORD_MISSING|the tenant must confirm|wait for the vendor/g) ?? []) expect(read, s).toContain(token);
    }
  });

  it("reads an answered park's rule as its two blocker halves, and leaves an unknown rule as core wrote it", () => {
    const answered = "Its question was answered, and the answer went to the run that asked (session 9f2c1a). That run moves the issue on once it reads the answer.";
    expect(standingRule(answered, "vi")).toBe(`${blockerText(answered.split(" That run")[0] as string, "vi")} ${blockerText("That run moves the issue on once it reads the answer.", "vi")}`);
    expect(standingRule("a rule core added later", "vi")).toBe("a rule core added later");
    expect(localizeWaiting({ kind: "run", who: "Run", act: "working", rule: "lease held by box-1" }, "vi").rule).toBe(standingRule("lease held by box-1", "vi"));
  });
});

const GATE_SHORT = new Set(["Another job active", "Run paused", "No runner online", "Retry cooldown", "Runner build too old", "Step held"]);
