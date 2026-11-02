// @direct-test-of packages/web-v2/src/features/releases/components/release-checks.tsx
// ISS-869: a no-production draft's decision, taken by its approver on its version, reads on the
// release's page as the decision and who took it; a draft nobody decided shows no approval at all.

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { ReleaseDetail } from "../types";
import { ReleaseHistory } from "./release-checks";

const draft = (over: Partial<ReleaseDetail> = {}) =>
  ({
    version: "0.1.0",
    state: "draft",
    attempts: [],
    approvals: [],
    cuts: [],
    draftApproval: null,
    ...over,
  }) as unknown as ReleaseDetail;

describe("a draft's decision on the release page", () => {
  it("shows who decided it and why", () => {
    renderWithQuery(
      <ReleaseHistory
        slug="autoflow"
        r={draft({
          draftApproval: {
            id: "d1",
            version: "0.1.0",
            decision: "approved",
            decidedBy: { id: "u1", name: "Lan", kind: "human" },
            decidedAt: "2026-11-02T10:00:00.000Z",
            reason: "notes read; open the upstream MR",
          },
        })}
      />,
    );
    const row = screen.getByTestId("release-draft-approval");
    expect(row.textContent).toContain("decided by Lan");
    expect(row.textContent).toContain("notes read; open the upstream MR");
  });

  it("shows nothing where nobody decided it", () => {
    renderWithQuery(<ReleaseHistory slug="autoflow" r={draft()} />);
    expect(screen.queryByTestId("release-draft-approval")).toBeNull();
    expect(screen.queryByTestId("release-history")).toBeNull();
  });
});
