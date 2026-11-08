// ISS-1077: a release over several production sites names each one with its status, so a site the
// release did not reach reads as not shipped by its name; what it serves opens on demand.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReleaseDetail } from "../types";
import { ReleaseSites } from "./release-sites";

type Site = ReleaseDetail["sites"][number];
const site = (name: string, state: Site["state"], serves: string | null = null): Site => ({
  name,
  state,
  serves,
  url: `https://${name}.example.test`,
});

describe("Production sites on a release", () => {
  it("says nothing where production is one site", () => {
    const { container } = render(<ReleaseSites r={{ sites: [site("production", "shipped", "1.2.0")] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names each site with its status, the one not reached as not shipped", () => {
    render(<ReleaseSites r={{ sites: [site("production", "shipped", "1.2.0"), site("webmail", "not_reached")] }} />);
    const rows = screen.getAllByTestId("release-site");
    expect(rows.map((r) => [r.getAttribute("data-site"), r.getAttribute("data-state")])).toEqual([
      ["production", "shipped"],
      ["webmail", "not_reached"],
    ]);
    expect(within(rows[1]).getByText("Not shipped")).toBeTruthy();
    // what it serves is detail on demand: the screen reader hears it, the face shows the status
    expect(within(rows[0]).getByText("Serves 1.2.0 · https://production.example.test")).toBeTruthy();
  });
});
