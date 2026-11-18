// ISS-1334 (FB-744): a release run's account of its release, the `note` its finish carried, shows on
// the release's record in one place, behind one short label, where it was before a comment on each
// roster issue; a release whose run gave none shows no label at all.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReleaseRecord } from "./release-record";

const shipped = {
  version: "0.5.0",
  state: "shipped",
  releasedAt: "2026-10-29T09:00:00.000Z",
  gates: [],
  notes: { designs: [], attention: [], sections: [], language: "en" },
  feedbackAnswered: [],
  corrections: [],
  cuts: [],
  attempts: [],
  approvals: [],
  tag: null,
};
const ACCOUNT = "Tagged v0.5.0 and pushed it; read the deploy workflow; the release-runner preference was honoured.";

describe("a release run's account on the release record (ISS-1334)", () => {
  it("shows the account behind its label, opened on demand", () => {
    render(<ReleaseRecord r={{ ...shipped, account: ACCOUNT } as never} slug="orbit" />);
    const account = screen.getByTestId("release-account");
    expect(account.tagName).toBe("DETAILS");
    expect(account).toHaveTextContent("Run account");
    expect(account).toHaveTextContent(ACCOUNT);
  });

  it("shows nothing where the run gave no account", () => {
    render(<ReleaseRecord r={{ ...shipped, account: null } as never} slug="orbit" />);
    expect(screen.queryByTestId("release-account")).toBeNull();
  });
});
