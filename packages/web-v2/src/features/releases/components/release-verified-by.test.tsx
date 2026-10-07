// The release page says how its close is proved: on a storefront, by what the provider serves, never
// by a commit nothing records there.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReleaseDetail } from "../types";
import { ReleaseFacts } from "./release-facts";

const release = (verifiedBy: ReleaseDetail["verifiedBy"]) =>
  ({
    criteria: { proven: 0, failing: 0, open: 0, total: 0 },
    approval: null,
    approvalRequired: false,
    approvers: [],
    owner: null,
    ownerAct: null,
    openedAt: null,
    releasedAt: null,
    head: null,
    state: "shipped",
    current: true,
    production: { name: "production", url: "https://hop.auto.sidcorp.co" },
    verifiedBy,
  }) as unknown as ReleaseDetail;

describe("Verified by on a release", () => {
  it("names the storefront provider whose published state proves the release", () => {
    render(<ReleaseFacts r={release({ kind: "provider", provider: "Autoflow" })} />);
    expect(screen.getByTestId("release-verified-by").textContent).toContain("What Autoflow serves");
  });

  it("keeps a git project's deployment record as it was", () => {
    render(<ReleaseFacts r={release({ kind: "deployment", provider: "Coolify" })} />);
    expect(screen.getByTestId("release-verified-by").textContent).toContain("Production's deployment record");
  });

  it("says nothing where no way of proving it is known", () => {
    render(<ReleaseFacts r={release(null)} />);
    expect(screen.queryByTestId("release-verified-by")).toBeNull();
  });
});
