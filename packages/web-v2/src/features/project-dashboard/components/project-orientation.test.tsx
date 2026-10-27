// The HOP journey walk (2026-10-08): the first screen was a release ticker and a 33-row ask table;
// what HOP is, its modules and where it stands sat below 1.75 screens or nowhere. The home opens
// with a header that says what the project is, its business modules, what is in delivery now and
// what comes next, as chips with a count; each line says so plainly when there is nothing to show.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectOrientation, type OrientationProps } from "./project-orientation";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const item = (key: string, title: string) => ({ key, title, state: "in_delivery" as const, delivery: null, deferral: null });

const HOP: OrientationProps = {
  slug: "hop",
  description: "A hospital CRM: patients, campaigns, loyalty and service recovery.",
  modules: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `Module ${i + 1}`, slug: `module-${i + 1}` })),
  now: [item("REQ-7", "Referrals"), item("REQ-10", "Recall"), item("REQ-28", "Loyalty"), item("REQ-31", "No-show")],
  next: [item("REQ-12", "Campaign approval")],
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

  it("says what is in delivery now and what comes next, each a chip with its count", () => {
    render(<ProjectOrientation {...HOP} />);
    expect(screen.getByTestId("orient-now")).toHaveTextContent(/^Now4/);
    expect(line("now").getByRole("link", { name: "REQ-7 Referrals" })).toHaveAttribute("href", "/projects/hop/requirements/REQ-7");
    expect(line("now").getAllByRole("link")).toHaveLength(4);
    expect(line("next").getByRole("link", { name: "REQ-12 Campaign approval" })).toBeInTheDocument();
  });

  it("names four requirements a row and counts the rest", () => {
    render(<ProjectOrientation {...HOP} now={[...HOP.now, item("REQ-40", "Recall SMS"), item("REQ-41", "Waitlist")]} />);
    expect(line("now").getAllByRole("link")).toHaveLength(4);
    expect(screen.getByTestId("orient-now")).toHaveTextContent("+2 more");
  });

  it("says so plainly where a line has nothing to show", () => {
    render(<ProjectOrientation slug="hop" description={null} modules={[]} now={[]} next={[]} />);
    expect(screen.getByTestId("orient-description")).toHaveTextContent("No description");
    expect(screen.getByTestId("orient-modules")).toHaveTextContent("No modules");
    expect(screen.getByTestId("orient-now")).toHaveTextContent("Nothing now");
    expect(screen.getByTestId("orient-next")).toHaveTextContent("Nothing next");
  });
});
