// The HOP journey walk (2026-10-08): the first screen was a release ticker and a 33-row ask table;
// what HOP is, its modules and where it stands sat below 1.75 screens or nowhere. The home opens
// with a header that says what the project is, its business modules, what is in delivery now, the
// release, and what comes next; each line says so plainly when there is nothing to show.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectOrientation, type OrientationProps } from "./project-orientation";

const item = (key: string, title: string) => ({ key, title, state: "in_delivery" as const, delivery: null, deferral: null });

const HOP: OrientationProps = {
  slug: "hop",
  description: "A hospital CRM: patients, campaigns, loyalty and service recovery.",
  modules: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `Module ${i + 1}`, slug: `module-${i + 1}` })),
  now: [item("REQ-7", "Referrals"), item("REQ-10", "Recall"), item("REQ-28", "Loyalty"), item("REQ-31", "No-show")],
  next: [item("REQ-12", "Campaign approval")],
  live: { version: "0.5.0", where: "hop.auto.sidcorp.co" },
  draft: { version: "0.6.0", eta: "around 14 Oct" },
};

const line = (name: string) => within(screen.getByTestId(`orient-${name}`));

describe("a project home that orients", () => {
  it("says what the project is first", () => {
    render(<ProjectOrientation {...HOP} />);
    expect(screen.getByTestId("orient-description")).toHaveTextContent("A hospital CRM");
  });

  it("names up to ten business modules, each a link, and how many more", () => {
    render(<ProjectOrientation {...HOP} />);
    const links = line("modules").getAllByRole("link");
    expect(links.slice(0, 10).map((a) => a.getAttribute("href"))).toEqual(Array.from({ length: 10 }, (_, i) => `/projects/hop/modules/module-${i + 1}`));
    expect(line("modules").getByRole("link", { name: "+2 more" })).toHaveAttribute("href", "/projects/hop/modules");
  });

  it("says what is in delivery now, the release, and what comes next", () => {
    render(<ProjectOrientation {...HOP} />);
    expect(screen.getByTestId("orient-now")).toHaveTextContent("4 requirements in delivery");
    expect(line("now").getByRole("link", { name: "REQ-7 Referrals" })).toHaveAttribute("href", "/projects/hop/requirements/REQ-7");
    expect(screen.getByTestId("orient-release")).toHaveTextContent("0.5.0 is live at hop.auto.sidcorp.co");
    expect(screen.getByTestId("orient-release")).toHaveTextContent("0.6.0 is being prepared, around 14 Oct");
    expect(line("next").getByRole("link", { name: "REQ-12 Campaign approval" })).toBeInTheDocument();
  });

  it("says so plainly where a line has nothing to show", () => {
    render(<ProjectOrientation slug="hop" description={null} modules={[]} now={[]} next={[]} live={null} draft={null} />);
    expect(screen.getByTestId("orient-description")).toHaveTextContent("No description yet");
    expect(screen.getByTestId("orient-modules")).toHaveTextContent("No business modules are declared yet");
    expect(screen.getByTestId("orient-now")).toHaveTextContent("Nothing is in delivery");
    expect(screen.getByTestId("orient-release")).toHaveTextContent("No release yet");
    expect(screen.getByTestId("orient-next")).toHaveTextContent("Nothing agreed is waiting");
  });
});
