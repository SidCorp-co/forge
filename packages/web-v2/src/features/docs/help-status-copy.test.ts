/**
 * ISS-1108 — the help screen names two different endings. `Closed` says the work went out and is
 * refused when it cannot show it; `Dropped` says it will not happen. Copy that calls the second a
 * kind of the first tells a reader to take a route the product refuses.
 */

import { describe, expect, it } from "vitest";
import { NO_SCHEDULE, RELEASES_ITSELF } from "@/features/issues/components/awaiting-release-banner";
import { releaseNoteHeading } from "@/features/issues/components/release-note-section";
import { statusLabel } from "@/features/issues/derive";
import { HELP_DOCS } from "./help-content.generated";

const CLOSES_IT_AS_THE_DISCARD = /clos(e|es|ed|ing)\b[^.;:]{0,60}\bas\s+[*_]*dropp?ed/i;
const CALLS_THE_DISCARD_A_CLOSE = /\bdropp?ed\b[^.;:]{0,40}\b(?:is|are|was|were|gets?|got)\s+clos(e|ed)\b/i;

const NAMES_THE_RELEASED_TERMINAL = /\bclosed\b/i;
const CLAIMS_IT_WENT_OUT = /\b(?:shipped|went out)\b/i;
const SAYS_WHAT_THE_CLOSE_WAS_REFUSED_FOR = /refus|unless|from now on|predate|before (?:this|the) rule/i;

/**
 * `Closed` carries a claim the work went out because entering it is refused without one. Rows closed
 * before that rule keep the state and carry nothing, so copy asserting the state itself went out is false
 * to the reader looking at one.
 */
function sentencesClaimingEveryClosedIssueWentOut(body: string): string[] {
  return body
    .split(/(?<=[.;:])\s+/)
    .filter((sentence) => NAMES_THE_RELEASED_TERMINAL.test(sentence))
    .filter((sentence) => CLAIMS_IT_WENT_OUT.test(sentence))
    .filter((sentence) => !SAYS_WHAT_THE_CLOSE_WAS_REFUSED_FOR.test(sentence));
}

function sentencesCallingTheDiscardAClose(body: string): string[] {
  return body
    .split(/(?<=[.;:])\s+/)
    .filter(
      (sentence) =>
        CLOSES_IT_AS_THE_DISCARD.test(sentence) || CALLS_THE_DISCARD_A_CLOSE.test(sentence),
    );
}

describe("the help docs, where they describe the two endings", () => {
  it.each(HELP_DOCS.map((doc) => [doc.slug, doc.body] as const))(
    "calls dropping an issue no kind of close (%s)",
    (_slug, body) => {
      expect(sentencesCallingTheDiscardAClose(body)).toEqual([]);
    },
  );

  it("tells the reader what a close is refused for", () => {
    const statuses = HELP_DOCS.find((doc) => doc.slug === "issue-statuses");
    expect(statuses?.body).toMatch(/closing is refused unless the work\s+went out/);
  });

  it.each(HELP_DOCS.map((doc) => [doc.slug, doc.body] as const))(
    "claims no closed issue went out without saying what the close was refused for (%s)",
    (_slug, body) => {
      expect(sentencesClaimingEveryClosedIssueWentOut(body)).toEqual([]);
    },
  );
});

describe("that guard, against the wordings the conflation comes back in", () => {
  const recurrences = [
    "Closing an issue as *dropped* records that the work is not going to happen.",
    "Close the issue as dropped when you decide against it.",
    "A dropped issue is closed without the work having happened.",
  ];

  it.each(recurrences)("rejects %s", (sentence) => {
    expect(sentencesCallingTheDiscardAClose(sentence)).toEqual([sentence]);
  });

  it("lets the copy this product actually carries through", () => {
    const carried = [
      "*Dropped* is its own ending rather than a kind of close.",
      "*Closed* says the work went out, and an issue that never went out is refused a close.",
      "Dropped issues are kept, and appear alongside closed ones under **Finished**.",
    ];
    expect(sentencesCallingTheDiscardAClose(carried.join(" "))).toEqual([]);
  });

  it.each([
    "| **Closed** | nobody | Done — the work shipped. |",
    "A closed issue is one whose work went out.",
  ])("rejects the unconditional claim it went out: %s", (copy) => {
    const offenders = sentencesClaimingEveryClosedIssueWentOut(copy);
    expect(offenders).toHaveLength(1);
    expect(copy).toContain(offenders[0]);
  });
});

/** The statuses a person parks an issue at: the Needs you tile lists one parked at any of them. */
const PARKED_STATUSES = ["needs_info", "waiting", "on_hold"] as const;

describe("the help page's account of what Needs you counts", () => {
  const body = HELP_DOCS.find((doc) => doc.slug === "issue-statuses")?.body ?? "";
  const paragraph = body.split(/\n\s*\n/).find((p) => p.includes("**Needs you**")) ?? "";

  it("is there to read", () => {
    expect(paragraph).not.toBe("");
  });

  it.each(PARKED_STATUSES)("names %s among the statuses a parked issue is counted at", (status) => {
    expect(paragraph.replace(/\s+/g, " ")).toContain(statusLabel(status));
  });

  it("says a cut list is shown as a part of at least the whole", () => {
    expect(paragraph.replace(/\s+/g, " ")).toMatch(/of at least/);
  });
});

/** The help quotes the issue page, so it is held to the page's own words (ISS-1421 r40, judge-164). */
describe("What done means, where it quotes the issue page", () => {
  const body = (HELP_DOCS.find((doc) => doc.slug === "what-done-means")?.body ?? "").replace(/\s+/g, " ");

  it.each([NO_SCHEDULE, RELEASES_ITSELF])("quotes the Awaiting release banner as it reads: %s", (said) => {
    expect(body).toContain(`*"${said}"*`);
  });

  it.each(["closed", "awaiting_release", "reopen"] as const)("names the release note heading at %s as the page does", (status) => {
    expect(body).toContain(`**${releaseNoteHeading(status)}**`);
  });
});
