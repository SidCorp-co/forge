// The Technical section's requirement row says what its number counts (REQ-40 BC-5): the checks that
// trace to the requirement, never a bare "Checks met" beside the release's one proof number (ISS-1001).

import type { ReleasePageRequirement } from "@forge/contracts/release-page";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RequirementLine } from "./release-groups";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const requirement = (key: string, business: ReleasePageRequirement["business"], rows = 0): ReleasePageRequirement => ({
  key,
  title: `Requirement ${key}`,
  completes: false,
  proven: Array.from({ length: rows }, (_, i) => ({ code: "BC-1", statement: `Check ${i}.`, short: false, issueKey: "ISS-1", n: i + 1, countedUnderCutover: false })),
  unproven: 0,
  business,
});
describe("the Technical view's requirement row says what its number counts", () => {
  it("says the checks that trace to the requirement, never a bare 'Checks met' beside the release's own count", () => {
    render(<RequirementLine r={requirement("REQ-1", { total: 6, proven: [] }, 53)} slug="hop" />);
    const row = screen.getByTestId("page-requirement");
    expect(row).toHaveTextContent("53 checks trace to REQ-1");
    expect(row).not.toHaveTextContent("Checks met");
  });
});
