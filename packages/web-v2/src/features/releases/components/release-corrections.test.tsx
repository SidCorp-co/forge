// A release lists each shipped-in correction that touched it as one short row: the issue, where it
// moved, and why on demand (ISS-846).

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseDetail } from "../types";
import { ReleaseCorrections } from "./release-corrections";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

type Correction = ReleaseDetail["corrections"][number];

const correction = (over: Partial<Correction>): Correction => ({
  direction: "out",
  key: "ISS-35",
  title: "Export the board",
  from: "0.38.0",
  to: "0.37.0",
  by: { id: "u1", name: "agenfold master", kind: "agent" },
  at: "2026-11-02T08:00:00Z",
  reason: "tag v0.37.0 points at the landing commit itself",
  evidence: "git tag --contains abc answered v0.37.0 v0.38.0",
  ...over,
});

describe("Corrections on a release", () => {
  it("renders nothing when no correction touched the release", () => {
    const { container } = render(<ReleaseCorrections r={{ corrections: [] }} slug="agenfold" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the issue moved off this release and where it went, the reason on hover and expand", () => {
    render(<ReleaseCorrections r={{ corrections: [correction({})] }} slug="agenfold" />);
    const row = screen.getByTestId("release-correction-row");
    expect(row.getAttribute("data-direction")).toBe("out");
    expect(within(row).getByRole("link", { name: "ISS-35" }).getAttribute("href")).toBe("/projects/agenfold/issues/ISS-35");
    const moved = within(row).getByText("Moved to 0.37.0");
    expect(moved.getAttribute("title")).toBe("tag v0.37.0 points at the landing commit itself");
    expect(within(row).getByText("Why")).toBeTruthy();
    expect(within(row).getByText("tag v0.37.0 points at the landing commit itself")).toBeTruthy();
    expect(within(row).getByText(/agenfold master/)).toBeTruthy();
    expect(row.textContent).not.toContain("u1");
  });

  it("names the issue moved onto this release and where it came from", () => {
    render(<ReleaseCorrections r={{ corrections: [correction({ direction: "in" })] }} slug="agenfold" />);
    expect(screen.getByText("Moved from 0.38.0")).toBeTruthy();
  });
});
