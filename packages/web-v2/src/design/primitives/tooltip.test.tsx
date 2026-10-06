// The tooltip is base-ui's, placed on <body> so a viewport edge or a clipping ancestor does not cut
// it (ISS-1172). The app mounts it under one TooltipProvider with no delay, as here. base-ui gives the
// popup no tooltip role (its label is a visual aid, the control names itself), so it is found by slot.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Tooltip } from "./tooltip";

const shown = () => document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
const findShown = () => waitFor(() => {
  const el = shown();
  if (!el) throw new Error("no tooltip is shown");
  return el;
});

function Clipped() {
  return (
    <TooltipProvider delay={0}>
      <div data-testid="clip" style={{ overflow: "hidden" }}>
        <Tooltip label="Display density">
          <button type="button">density</button>
        </Tooltip>
      </div>
      <button type="button">elsewhere</button>
    </TooltipProvider>
  );
}

describe("Tooltip", () => {
  it("shows on hover, on <body> outside the clipping ancestor, and hides on leave", async () => {
    const user = userEvent.setup();
    render(<Clipped />);
    await user.hover(screen.getByText("density"));
    const tip = await findShown();
    expect(tip).toHaveTextContent("Display density");
    expect(screen.getByTestId("clip")).not.toContainElement(tip);
    await user.unhover(screen.getByText("density"));
    await waitFor(() => expect(shown()).toBeNull());
  });

  it("shows on keyboard focus and hides when focus moves on", async () => {
    const user = userEvent.setup();
    render(<Clipped />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByText("density"));
    expect(await findShown()).toHaveTextContent("Display density");
    await user.tab();
    await waitFor(() => expect(shown()).toBeNull());
  });

  it("does not hold the page still while shown", async () => {
    const user = userEvent.setup();
    render(<Clipped />);
    await user.hover(screen.getByText("density"));
    await findShown();
    expect(document.body.style.overflowY).toBe("");
    expect(document.body.style.overflow).toBe("");
  });
});
