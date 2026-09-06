// @vitest-environment jsdom
//
// ISS-791 — the shipped-work claim had no human surface at all: `POST /api/issues/:id/merge` was
// reachable only from the CLI and MCP, so a person who finished an issue by hand could not say so.
// These pin the two states of the control and the exact request each sends.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MergeMarkerControl } from "./merge-marker-control";

expect.extend(matchers);

const mark = vi.fn();
const unmark = vi.fn();

vi.mock("../hooks", () => ({
  useMergeMarker: () => ({ mark, unmark, isPending: false }),
}));

afterEach(() => {
  cleanup();
  mark.mockReset();
  unmark.mockReset();
});

describe("MergeMarkerControl", () => {
  it("offers the claim when nothing has been claimed, and sends the target it was given", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={null} suggestedTarget="ISS-791" />);

    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    // cm:why the trigger stays mounted behind the SlideOver, so the confirm is the LAST match — clicking the first one would re-open the dialog and pass while sending nothing
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1] as HTMLElement);

    expect(mark).toHaveBeenCalledWith({ target: "ISS-791" });
    expect(unmark).not.toHaveBeenCalled();
  });

  // cm:guard the note is OMITTED rather than sent empty — core's body schema is `.strict()` with `note` at min length 1, so a blank string is a 400 rather than a no-op
  it("omits an untouched note instead of sending an empty one", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={null} suggestedTarget="ISS-791" />);
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    fireEvent.change(screen.getByPlaceholderText(/where it landed|branch or PR/i), {
      target: { value: "  feature/by-hand  " },
    });
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);

    expect(mark).toHaveBeenCalledWith({ target: "feature/by-hand" });
  });

  it("offers the retraction once a claim exists, and never the claim", () => {
    render(
      <MergeMarkerControl issueId="i1" mergedAt="2026-09-01T00:00:00.000Z" suggestedTarget="ISS-791" />,
    );

    expect(screen.queryByRole("button", { name: "Mark merged" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unmark" }));
    expect(unmark).toHaveBeenCalledTimes(1);
  });
});
