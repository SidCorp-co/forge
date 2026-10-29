// REQ-63 BC-15: a shipped release's rail shows its tag on the source host, the tag's own name where
// the host holds it, else one word for why not; the sentence why is the developer view's record only.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReleaseRecord } from "./release-record";
import { WhereReleaseStands } from "./release-rail";

const SHIP = "f4e5fb66700ba7b35c8c607c8f7309fc5980861a";
const ASIDE = "bbbb0000000000000000000000000000000000b2";
const shipped = {
  version: "0.5.0",
  state: "shipped",
  releasedAt: "2026-10-29T09:00:00.000Z",
  approvalRequired: false,
  approval: null,
  approvers: [],
  production: null,
  ownerDeploys: false,
  verified: { level: "none", proven: 0, total: 0, check: null, provider: null, judgedOn: null },
  gates: [],
  notes: { designs: [], attention: [], sections: [], language: "en" },
  feedbackAnswered: [],
  cuts: [],
  attempts: [],
  approvals: [],
};
const at = "2026-10-29T09:00:01.000Z";
const conflict = {
  state: "refused",
  name: "v0.5.0",
  commit: SHIP,
  created: false,
  on: ASIDE,
  code: "RELEASE_TAG_CONFLICT",
  reason: `v0.5.0 already stands on ${ASIDE}, not on ${SHIP}, the commit this release shipped; Forge never moves a tag`,
  at,
};

describe("a shipped release's tag on its rail (REQ-63 BC-15)", () => {
  it("shows the tag's own name where the host holds it", () => {
    const tag = { state: "tagged", name: "v0.5.0", commit: SHIP, created: true, on: null, code: null, reason: null, at };
    render(<WhereReleaseStands r={{ ...shipped, tag } as never} />);
    expect(screen.getByTestId("standing-tag")).toHaveTextContent("Tagv0.5.0");
  });

  it("says one word where the tag was refused, and keeps the sentence off the rail", () => {
    render(<WhereReleaseStands r={{ ...shipped, tag: conflict } as never} />);
    expect(screen.getByTestId("standing-tag")).toHaveTextContent("TagRefused");
    expect(screen.getByTestId("release-standing")).not.toHaveTextContent(ASIDE);
  });

  it("says why there is none where the project has no source host", () => {
    const tag = { ...conflict, state: "untagged", on: null, code: "RELEASE_TAG_NO_SOURCE_HOST", reason: "no binding" };
    render(<WhereReleaseStands r={{ ...shipped, tag } as never} />);
    expect(screen.getByTestId("standing-tag")).toHaveTextContent("TagNo source host");
  });

  it("says None for a release shipped before releases were tagged, and nothing before it ships", () => {
    const { unmount } = render(<WhereReleaseStands r={{ ...shipped, tag: null } as never} />);
    expect(screen.getByTestId("standing-tag")).toHaveTextContent("TagNone");
    unmount();
    render(<WhereReleaseStands r={{ ...shipped, state: "draft", releasedAt: null, tag: null } as never} />);
    expect(screen.queryByTestId("standing-tag")).toBeNull();
  });

  it("names the refusal in full on the developer view's record", () => {
    render(<ReleaseRecord r={{ ...shipped, tag: conflict } as never} slug="orbit" />);
    expect(screen.getByTestId("release-tag-why")).toHaveTextContent(`Tag v0.5.0: v0.5.0 already stands on ${ASIDE}`);
  });
});
