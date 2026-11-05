// REQ-63 r7 BC-15: a release shows its tag on the source host, in its Technical section (ISS-1001), from
// the moment the commit its version names is known and before any deploy: Pending while the host is
// asked, the tag's own name where the host holds it, else one word for why not; the sentence why is the
// record's only.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReleaseRecord, ReleaseTagLine } from "./release-record";

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
  corrections: [],
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
  reason: `v0.5.0 already stands on ${ASIDE}, not on ${SHIP}, the commit this release names; Forge never moves a tag`,
  at,
};

describe("a release's tag (REQ-63 BC-15)", () => {
  it("shows Pending for a release not yet shipped whose commit is known", () => {
    const tag = { state: "owed", name: "v0.5.0", commit: SHIP, created: false, on: null, code: null, reason: null, at };
    render(<ReleaseTagLine r={{ ...shipped, state: "running", releasedAt: null, tag } as never} />);
    expect(screen.getByTestId("standing-tag")).toHaveTextContent("Tag Pending");
  });

  it("shows the tag's name before the release ships, once the host holds it", () => {
    const tag = { state: "tagged", name: "v0.5.0", commit: SHIP, created: true, on: null, code: null, reason: null, at };
    render(<ReleaseTagLine r={{ ...shipped, state: "running", releasedAt: null, tag } as never} />);
    expect(screen.getByTestId("standing-tag")).toHaveTextContent("Tag v0.5.0");
  });

  it("shows the tag's own name where the host holds it", () => {
    const tag = { state: "tagged", name: "v0.5.0", commit: SHIP, created: true, on: null, code: null, reason: null, at };
    render(<ReleaseTagLine r={{ ...shipped, tag } as never} />);
    expect(screen.getByTestId("standing-tag")).toHaveTextContent("Tag v0.5.0");
  });

  it("says one word where the tag was refused, and keeps the sentence off the line", () => {
    render(<ReleaseTagLine r={{ ...shipped, tag: conflict } as never} />);
    expect(screen.getByTestId("standing-tag")).toHaveTextContent("Tag Refused");
    expect(screen.getByTestId("standing-tag")).not.toHaveTextContent(ASIDE);
  });

  it("says why there is none where the project has no source host", () => {
    const tag = { ...conflict, state: "untagged", on: null, code: "RELEASE_TAG_NO_SOURCE_HOST", reason: "no binding" };
    render(<ReleaseTagLine r={{ ...shipped, tag } as never} />);
    expect(screen.getByTestId("standing-tag")).toHaveTextContent("Tag No host");
  });

  it("says None for a release shipped before releases were tagged, and nothing before its commit is known", () => {
    const { unmount } = render(<ReleaseTagLine r={{ ...shipped, tag: null }} />);
    expect(screen.getByTestId("standing-tag")).toHaveTextContent("Tag None");
    unmount();
    render(<ReleaseTagLine r={{ ...shipped, state: "draft", releasedAt: null, tag: null } as never} />);
    expect(screen.queryByTestId("standing-tag")).toBeNull();
  });

  it("names the refusal in full on the developer view's record", () => {
    render(<ReleaseRecord r={{ ...shipped, tag: conflict } as never} slug="orbit" />);
    expect(screen.getByTestId("release-tag-why")).toHaveTextContent(`Tag v0.5.0: v0.5.0 already stands on ${ASIDE}`);
  });
});
