/**
 * ISS-1108 — the help screen names two different endings. `Closed` says the work shipped and is
 * refused when it cannot show it; `Dropped` says it will not happen. Copy that calls the second a
 * kind of the first tells a reader to take a route the product refuses.
 */

import { describe, expect, it } from "vitest";
import { HELP_DOCS } from "./help-content.generated";

const CLOSES_IT_AS_THE_DISCARD = /clos(e|es|ed|ing)\b[^.;:]{0,60}\bas\s+[*_]*dropp?ed/i;
const CALLS_THE_DISCARD_A_CLOSE = /\bdropp?ed\b[^.;:]{0,40}\b(?:is|are|was|were|gets?|got)\s+clos(e|ed)\b/i;

function sentencesCallingTheDiscardAClose(body: string): string[] {
  return body
    .split(/(?<=[.;:])\s+/)
    .filter(
      (sentence) =>
        CLOSES_IT_AS_THE_DISCARD.test(sentence) || CALLS_THE_DISCARD_A_CLOSE.test(sentence),
    );
}

describe("the shipped help docs, where they describe the two endings", () => {
  it.each(HELP_DOCS.map((doc) => [doc.slug, doc.body] as const))(
    "calls dropping an issue no kind of close (%s)",
    (_slug, body) => {
      expect(sentencesCallingTheDiscardAClose(body)).toEqual([]);
    },
  );

  it("tells the reader what Closed claims", () => {
    const statuses = HELP_DOCS.find((doc) => doc.slug === "issue-statuses");
    expect(statuses?.body).toMatch(/the work shipped/);
  });
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

  it("lets the copy this product actually ships through", () => {
    const shipped = [
      "*Dropped* is its own ending rather than a kind of close.",
      "*Closed* says the work shipped, and an issue that never shipped is refused a close.",
      "Dropped issues are kept, and appear alongside closed ones under **Finished**.",
    ];
    expect(sentencesCallingTheDiscardAClose(shipped.join(" "))).toEqual([]);
  });
});
