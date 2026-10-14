// The list's filter is a menu whose trigger is drawn by a component (the button and a dot showing a
// filter is on). The menu hands its trigger props to that component, and they must reach the button:
// a component that drops them leaves a button that opens nothing.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Menu } from "@/design";
import { FilterTrigger } from "./conversation-list";

describe("the conversation list's filter", () => {
  it("opens its menu from the filter button, which is the menu's one trigger", async () => {
    const user = userEvent.setup();
    render(<Menu trigger={<FilterTrigger filtered={false} label="All" />} items={[{ label: "Open only" }]} />);
    const button = screen.getByRole("button", { name: "Filter conversations" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    await user.click(button);
    expect(await screen.findByRole("menuitem", { name: "Open only" })).toBeInTheDocument();
  });
});
