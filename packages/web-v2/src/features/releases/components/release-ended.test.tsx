// HOP's /releases/0.4.0 said only that its issues shipped in 0.5.0 and then drew 0.5.0's body: why
// 0.4.0 was cancelled was under 0.5.0's Checks tab, in English. Its own page now opens with it.

import { say } from "@forge/contracts/said";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { renderWithQuery } from "@/test/render";
import { EndedAttempt, ReleaseAttempts } from "./release-attempts";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

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
  failure: null,
  repair: null,
  decidedBy: null,
  rule: { decided: "unrecorded", from: null, carriers: [], line: null, taken: false, overtaken: null },
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

// forge, ISS-586: a re-cut of dev.211's roster after dev.226 shipped wore dev.211 again. It now takes
// the next above, and its attempt says which version it had to go above.
describe("a re-cut moved above a version claimed since", () => {
  const recut = {
    version: "0.4.0-dev.227",
    runId: "run-2",
    state: "in_progress",
    cuts: [
      cut(1, "0.4.0-dev.211", "aborted", { carried: [] }),
      cut(2, "0.4.0-dev.227", "in_progress", {
        rule: { decided: "bumped", from: "0.4.0-dev.211", carriers: [], line: null, taken: false, overtaken: "0.4.0-dev.226" },
      }),
    ],
  };

  it("names the version it went above", () => {
    renderWithQuery(<ReleaseAttempts r={recut as never} slug="forge" />);
    const rules = screen.getAllByTestId("cut-rule");
    expect(rules[1]).toHaveTextContent("A new version, 0.4.0-dev.227: 0.4.0-dev.211 is below 0.4.0-dev.226, claimed since.");
  });

  it("names it in Vietnamese", () => {
    renderWithQuery(
      <InterfaceLanguageScope language="vi">
        <ReleaseAttempts r={recut as never} slug="forge" />
      </InterfaceLanguageScope>,
    );
    expect(screen.getAllByTestId("cut-rule")[1]).toHaveTextContent("0.4.0-dev.211 thấp hơn 0.4.0-dev.226"); // i18n-allow: Vietnamese text under test
  });
});

// ISS-761, catalog-api 0.4.0: a release that failed read "No reason" though its close recorded one.
describe("a release its close failed", () => {
  const FAILURE = { code: "release_record_incomplete", detail: "1 of the recorded issues would not close: ISS-12 (a refusal)", step: null };
  const failed = (over: object = {}) => ({
    version: "0.4.0",
    runId: "run-1",
    state: "failed",
    cuts: [cut(1, "0.4.0", "failed", { failure: FAILURE, ...over })],
  });

  it("says what failed it, never that no reason was recorded", () => {
    renderWithQuery(<EndedAttempt r={failed() as never} slug="catalog" />);
    const ended = screen.getByTestId("release-ended");
    expect(within(ended).getByTestId("release-ended-failure")).toHaveTextContent("ISS-12");
    expect(ended).not.toHaveTextContent("No reason");
  });

  it("reads no reason only where nothing on the attempt says one", () => {
    renderWithQuery(<EndedAttempt r={failed({ failure: null }) as never} slug="catalog" />);
    expect(screen.getByTestId("release-ended")).toHaveTextContent("No reason");
  });

  it("names a person's repair on the attempt that shipped after all", () => {
    const repaired = {
      ...failed({
        outcome: "shipped",
        repair: { outcome: "shipped", by: { id: "u1", name: "Lan", kind: "human" }, at: "2026-11-02T00:00:00.000Z", reason: "It landed and served.", evidence: "!1023", was: { status: "failed", failureCode: FAILURE.code } },
      }),
      state: "shipped",
    };
    renderWithQuery(<ReleaseAttempts r={repaired as never} slug="catalog" />);
    expect(screen.getByTestId("cut-repair")).toHaveTextContent("Shipped, recorded by Lan: It landed and served.");
    expect(screen.getByTestId("cut-failure")).toHaveTextContent("ISS-12");
  });
});
