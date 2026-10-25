// REQ-35 BC-9: a release shows each requirement as a bar of criteria passed. Before ISS-463 the
// release page listed each requirement as text ("Moves BC-1.", "Not yet passing: BC-2."), so its
// progress had to be read rather than seen. REQ-40 counts it in one place, the rail: the bar is drawn
// out of the requirement's own total from the same count its words say, so the page cannot show
// "0/6 criteria passing" beside "0 of its 6 criteria proven", nor "Checks met: 53" beside "All 133
// checks met".

import type { ReleasePageRequirement } from "@forge/contracts/release-page";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { RailRequirements } from "./release-rail";
import { RequirementLine } from "./release-groups";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const proven = (n: number) => Array.from({ length: n }, (_, i) => ({ code: `BC-${i + 1}`, statement: `Criterion ${i + 1}.` }));
const requirement = (key: string, business: ReleasePageRequirement["business"], rows = 0): ReleasePageRequirement => ({
  key,
  title: `Requirement ${key}`,
  completes: false,
  proven: Array.from({ length: rows }, (_, i) => ({ code: "BC-1", statement: `Check ${i}.`, short: false, issueKey: "ISS-1", n: i + 1, countedUnderCutover: false })),
  unproven: 0,
  business,
});
const rail = (...requirements: ReleasePageRequirement[]) => render(<RailRequirements page={releasePage({ requirements })} slug="hop" />);
const bar = (row: HTMLElement) => within(row).getByRole("img");
const widths = (row: HTMLElement) => [...bar(row).children].map((s) => (s as HTMLElement).style.width);

describe("a requirement counted once, in the rail, as a bar out of its own total (REQ-35 BC-9, REQ-40 BC-5)", () => {
  it("draws each requirement's criteria proven out of that requirement's total, its words saying the same count", () => {
    rail(requirement("REQ-1", { total: 4, proven: proven(1) }), requirement("REQ-2", { total: 6, proven: [] }));
    const [one, two] = screen.getAllByTestId("rail-requirement") as [HTMLElement, HTMLElement];
    expect(one).toHaveTextContent("1 of its 4 criteria proven");
    expect(widths(one)).toEqual(["25%", "75%"]);
    expect(two).toHaveTextContent("0 of its 6 criteria proven");
    expect(widths(two)).toEqual(["100%"]);
  });

  it("names each segment and its count for a screen reader", () => {
    rail(requirement("REQ-1", { total: 3, proven: proven(2) }));
    expect(bar(screen.getByTestId("rail-requirement")).getAttribute("aria-label")).toBe("Proven on this release 2, Not proven yet 1");
  });

  it("grows the proven segment by one criterion when this release proves one more", () => {
    const { unmount } = rail(requirement("REQ-1", { total: 3, proven: proven(1) }));
    expect(Number.parseFloat(widths(screen.getByTestId("rail-requirement"))[0] ?? "")).toBeCloseTo(100 / 3);
    unmount();
    rail(requirement("REQ-1", { total: 3, proven: proven(2) }));
    expect(Number.parseFloat(widths(screen.getByTestId("rail-requirement"))[0] ?? "")).toBeCloseTo(200 / 3);
  });

  it("says how many issue checks trace to a requirement with no criteria of its own, and draws no bar", () => {
    rail(requirement("REQ-1", null, 53));
    const row = screen.getByTestId("rail-requirement");
    expect(within(row).queryByRole("img")).toBeNull();
    expect(row).toHaveTextContent("53 checks trace to REQ-1");
  });
});

describe("the Technical view's requirement row says what its number counts", () => {
  it("says the checks that trace to the requirement, never a bare 'Checks met' beside the release's own count", () => {
    render(<RequirementLine r={requirement("REQ-1", { total: 6, proven: [] }, 53)} slug="hop" />);
    const row = screen.getByTestId("page-requirement");
    expect(row).toHaveTextContent("53 checks trace to REQ-1");
    expect(row).not.toHaveTextContent("Checks met");
  });
});
