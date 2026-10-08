// HOP's /releases/0.4.0 said only that its issues shipped in 0.5.0 and then drew 0.5.0's body: why
// 0.4.0 was cancelled was under 0.5.0's Checks tab, in English. Its own page now opens with it.

import { say } from "@forge/contracts/said";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { renderWithQuery } from "@/test/render";
import { EndedAttempt } from "./release-attempts";

const NOT_VERIFIED =
  "what Autoflow serves does not carry 1 landing(s) of this release: ISS-54 landed workflow `193` (`hop_referral`) at draft `999dcf6d`";
const cut = (n: number, version: string, outcome: string, over: object = {}) => ({
  n,
  runId: `run-${n}`,
  version,
  cutAt: "2026-10-07T20:00:00.000Z",
  cutBy: null,
  outcome,
  endedAt: null,
  refusal: null,
  abortReason: null,
  decidedBy: null,
  rule: { decided: "unrecorded", from: null, carriers: [], line: null, taken: false },
  carried: null,
  roster: [
    { key: "ISS-54", title: "Referral intake" },
    { key: "ISS-102", title: "Campaign report" },
  ],
  ...over,
});
const r040 = {
  version: "0.4.0",
  runId: "run-2",
  state: "aborted",
  cuts: [
    cut(1, "0.3.0", "aborted"),
    cut(2, "0.4.0", "aborted", {
      refusal: { code: "RELEASE_NOT_VERIFIED", text: NOT_VERIFIED, says: say("releases.refused.notVerified") },
      abortReason: "193 has never been published; ISS-110 owns it.",
      carried: [],
    }),
    cut(3, "0.5.0", "shipped"),
  ],
};

describe("a cancelled release's own page", () => {
  it("says why it was cancelled in Vietnamese, with the refusal's words behind a fold", () => {
    renderWithQuery(
      <InterfaceLanguageScope language="vi">
        <EndedAttempt r={r040 as never} slug="hop" />
      </InterfaceLanguageScope>,
    );
    const ended = screen.getByTestId("release-ended");
    expect(ended).toHaveTextContent("Vì sao bản 0.4.0 bị huỷ"); // i18n-allow: Vietnamese text under test
    expect(within(ended).getByTestId("release-ended-refusal")).toHaveTextContent("không chứng minh được"); // i18n-allow: Vietnamese text under test
    expect(within(ended).getByTestId("release-ended-refusal")).toHaveTextContent("RELEASE_NOT_VERIFIED");
    expect(within(ended).getByTestId("release-ended-abort")).toHaveTextContent("ISS-110");
  });

  it("lists the roster that attempt was cut with", () => {
    renderWithQuery(<EndedAttempt r={r040 as never} slug="hop" />);
    const roster = screen.getByTestId("release-ended-roster");
    expect(within(roster).getByText("ISS-54")).toBeInTheDocument();
    expect(roster).toHaveTextContent("This attempt was cut with 2 issues");
  });

  it("is not drawn on a release that shipped", () => {
    renderWithQuery(<EndedAttempt r={{ ...r040, state: "shipped" } as never} slug="hop" />);
    expect(screen.queryByTestId("release-ended")).toBeNull();
  });
});
