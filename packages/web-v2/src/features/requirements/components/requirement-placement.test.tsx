// The requirements list's placement banner (ISS-1179 item 7): at 390 px on forge-dev, 2026-11-09,
// "45 proposed areas and names / Accept all / 1 have no area or short name / Ask the assistant" took
// three rows above the first requirement. It folds to one line saying how many wait to be placed, its
// two acts opened on demand.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { RequirementSummary } from "../types";
import { inPlay, PlacementBanner } from "./requirement-placement";

const row = (key: string, over: Partial<RequirementSummary>) => ({ key, area: null, shortName: null, placementProposal: null, ...over }) as unknown as RequirementSummary;
const ROWS = [
  row("REQ-1", { placementProposal: { area: { id: "a1", name: "Product record" }, shortName: "Clarify feedback" } }),
  row("REQ-2", { placementProposal: { area: { id: "a1", name: "Product record" }, shortName: "Route feedback" } }),
  row("REQ-3", {}),
];

describe("the placement banner", () => {
  it("folds to one line saying how many wait to be placed, its acts opened on demand", () => {
    fakeCore(() => undefined);
    renderWithQuery(<PlacementBanner projectId="p1" rows={ROWS} hasAreas />);
    const banner = screen.getByTestId("placement-banner");
    // the line names what waits on the viewer, the assistant's proposals, not a count of everything unplaced (ISS-1191)
    expect(banner).toHaveTextContent("Areas and names");
    expect(banner).toHaveTextContent("2 proposed, to review");
    expect(screen.queryByRole("button", { name: "Accept all" }), "the acts stand behind the fold").toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Areas and names/ }));
    expect(screen.getByText("The assistant proposed an area or short name for 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask the assistant" })).toBeInTheDocument();
  });

  it("says how many are missing when nothing is proposed yet (ISS-1191)", () => {
    fakeCore(() => undefined);
    renderWithQuery(<PlacementBanner projectId="p1" rows={[row("REQ-3", {})]} hasAreas />);
    expect(screen.getByTestId("placement-banner")).toHaveTextContent("1 missing");
  });
});

describe("a requirement in play (ISS-1191)", () => {
  it("is neither dropped nor refused", () => {
    const statuses = ["draft", "agreed", "in_delivery", "delivered", "accepted", "deferred", "dropped", "refused"] as const;
    expect(statuses.filter((status) => inPlay(row("REQ-9", { status })))).toEqual(["draft", "agreed", "in_delivery", "delivered", "accepted", "deferred"]);
  });
});
