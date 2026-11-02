// At phone width the requirement's tabs never wrap (ISS-903): the Overview and the open tab stand,
// the rest wait behind one "More" menu, and choosing one opens it. Wider, every tab stands.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequirementTabs } from "./requirement-tabs";

const TABS = [
  { value: "overview" as const, label: "Overview", count: 2 },
  { value: "revisions" as const, label: "Revisions" },
  { value: "mockups" as const, label: "Mockups", count: 3 },
  { value: "activity" as const, label: "Activity" },
];
type T = (typeof TABS)[number]["value"];

const phone = (narrow: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: narrow, media: query, addEventListener: () => {}, removeEventListener: () => {} }));

afterEach(() => vi.unstubAllGlobals());

describe("the requirement's tabs", () => {
  it("draws every tab wide, with no More menu", () => {
    phone(false);
    render(<RequirementTabs<T> tabs={TABS} value="overview" onTab={() => {}} />);
    expect(screen.getAllByRole("tab").map((x) => x.textContent)).toEqual(["Overview2", "Revisions", "Mockups3", "Activity"]);
    expect(screen.queryByTestId("requirement-tabs-more")).toBeNull();
  });

  it("at phone width keeps the Overview and the open tab, the rest behind More, and opens the one chosen", async () => {
    phone(true);
    const user = userEvent.setup();
    const onTab = vi.fn();
    render(<RequirementTabs<T> tabs={TABS} value="activity" onTab={onTab} />);
    expect(screen.getAllByRole("tab").map((x) => x.textContent)).toEqual(["Overview2", "Activity"]);
    await user.click(screen.getByTestId("requirement-tabs-more"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((x) => x.textContent)).toEqual(["Revisions", "Mockups · 3"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Mockups · 3" }));
    expect(onTab).toHaveBeenCalledWith("mockups");
  });
});
