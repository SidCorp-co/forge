// The project home's header shows the project's name and its settings; the slug and the reader's role
// are not acted on, so they sit in the mark's tooltip (REQ-11 BC-18, BC-19).

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/design";
import { faceWords } from "@/test/screen-face";
import { ProjectHomeHeader } from "./project-home-header";

const header = (role: string, onSettings = () => {}) =>
  render(
    <TooltipProvider delay={0}>
      <ProjectHomeHeader project={{ name: "Hop Clinic API", slug: "hop-clinic", role }} glyph={{ tint: "#eef", ink: "#225" }} initials="HC" onSettings={onSettings} />
    </TooltipProvider>,
  );

describe("the project home's header (REQ-11 BC-18, BC-19)", () => {
  it("draws the name and the mark, and neither the slug nor the reader's role on its face", () => {
    const { container } = header("admin");
    expect(screen.getByRole("heading").textContent).toBe("Hop Clinic API");
    expect(container.textContent).not.toMatch(/admin|hop-clinic/i);
    expect(faceWords(container)).toBe(4);
  });

  it("says the slug and the role in the mark's tooltip", async () => {
    header("viewer");
    await userEvent.setup().hover(screen.getByText("HC"));
    // base-ui gives the popup no tooltip role, so it is found by slot (design/primitives/tooltip.test.tsx)
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent("hop-clinic · viewer"));
  });

  it("opens the settings from its labelled button", () => {
    const onSettings = vi.fn();
    header("member", onSettings);
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
  });
});
