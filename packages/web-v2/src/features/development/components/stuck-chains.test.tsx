// Delivery overview's stuck chains lead with titles (ISS-903): each issue is its title opening its page,
// its key that title's tooltip on hover or keyboard focus, never text on the face.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEV } from "@/test/vi-chrome-overview";
import { StuckChains } from "./stuck-chains";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

describe("stuck chains", () => {
  it("names each issue by its title opening its page, its key on focus, never on the face", async () => {
    const user = userEvent.setup();
    render(<StuckChains stuck={DEV.stuck} slug="hop" />);
    const chains = screen.getByTestId("stuck-chains");
    expect(within(chains).getAllByTestId("chain-node-title").map((a) => a.textContent)).toEqual(["Muc ba", "Muc bon"]);
    expect(chains.textContent).not.toMatch(/ISS-\d/);
    const first = within(chains).getByRole("link", { name: "Muc ba" });
    expect(first).toHaveAttribute("href", "/projects/hop/issues/ISS-3");
    await user.tab();
    expect(first).toHaveFocus();
    expect(await screen.findByText(/^ISS-3 · /)).toBeInTheDocument();
  });
});
