// @vitest-environment jsdom
//
// ISS-1166 / ISS-1169: a row that cannot be acted on carries no control. The type has no disabled
// state for an action, so what is asserted is that the action is absent, never greyed.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RowActions } from "./row-actions";

expect.extend(matchers);
afterEach(cleanup);

describe("RowActions", () => {
  it("draws each action the row has, named for the row it belongs to", () => {
    const revoke = vi.fn();
    render(<RowActions subject="ci" actions={[{ id: "revoke", label: "Revoke", onClick: revoke }]} />);
    const button = screen.getByRole("button", { name: "Revoke, ci" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("draws nothing for an action the row does not have, and nothing at all when it has none", () => {
    const { container } = render(<RowActions subject="old" actions={[false, null, undefined]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("leaves out the actions that are not offered and keeps the ones that are", () => {
    render(
      <RowActions
        subject="a"
        actions={[{ id: "give", label: "Give", onClick: () => {} }, false, { id: "self", label: "Self", onClick: () => {} }]}
      />,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Give", "Self"]);
  });

  it("holds every action while one is in flight, and says an inline one is open", () => {
    render(
      <RowActions
        subject="a"
        busy
        actions={[{ id: "self", label: "Self", expanded: true, onClick: () => {} }]}
      />,
    );
    const button = screen.getByRole("button", { name: "Self, a" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-expanded", "true");
  });
});
