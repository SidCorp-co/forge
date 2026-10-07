// HOP ISS-126 (dev, 2026-10-07): the New issue form's Preview toggle filed the issue, because a
// Button with no `type` was a submit button and HTML submits the form around it. A Button or an
// IconButton submits only when it says type="submit"; every other press leaves the form alone.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreviewPane } from "../patterns/preview-pane";
import { Button } from "./button";
import { IconButton } from "./icon-button";

function inForm(children: React.ReactNode) {
  const submitted = vi.fn((e: React.FormEvent) => e.preventDefault());
  render(<form onSubmit={submitted}>{children}</form>);
  return submitted;
}

describe("a button inside a form", () => {
  it("does not submit it when it names no type", () => {
    const submitted = inForm(
      <>
        <Button>Plain</Button>
        <IconButton icon="x" aria-label="Icon" />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Plain" }));
    fireEvent.click(screen.getByRole("button", { name: "Icon" }));
    expect(submitted).not.toHaveBeenCalled();
  });

  it("submits it when it says type submit", () => {
    const submitted = inForm(
      <>
        <Button type="submit">Send</Button>
        <IconButton type="submit" icon="x" aria-label="Send icon" />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Send icon" }));
    expect(submitted).toHaveBeenCalledTimes(2);
  });

  it("opens the preview without submitting the form it sits in", () => {
    const toggled = vi.fn();
    const submitted = inForm(
      <PreviewPane open={false} onToggle={toggled}>
        body
      </PreviewPane>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(toggled).toHaveBeenCalledTimes(1);
    expect(submitted).not.toHaveBeenCalled();
  });
});
