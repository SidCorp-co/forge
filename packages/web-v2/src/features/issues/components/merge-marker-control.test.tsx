// @vitest-environment jsdom
//
// ISS-791 — the shipped-work claim had no human surface at all: `POST /api/issues/:id/merge` was
// reachable only from the CLI and MCP, so a person who finished an issue by hand could not say so.
// These pin the two states of the control and the exact request each sends.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
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
    // The sheet is modal, so the trigger behind it leaves the accessibility tree: the one
    // "Mark merged" a reader can reach now is the sheet's own.
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    expect(buttons).toHaveLength(1);
    expect(screen.getByRole("dialog")).toContainElement(buttons[0] as HTMLElement);
    fireEvent.click(buttons[0] as HTMLElement);

    expect(mark).toHaveBeenCalledWith({ target: "ISS-791" }, expect.anything());
    expect(unmark).not.toHaveBeenCalled();
  });

  it("omits an untouched note instead of sending an empty one", () => {
    render(<MergeMarkerControl issueId="i1" mergedAt={null} suggestedTarget="ISS-791" />);
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    fireEvent.change(screen.getByPlaceholderText(/where it landed|branch or change request/i), {
      target: { value: "  feature/by-hand  " },
    });
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);

    expect(mark).toHaveBeenCalledWith({ target: "feature/by-hand" }, expect.anything());
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

describe("MergeMarkerControl on a project whose work lands outside git (ISS-1327)", () => {
  const open = () => {
    render(
      <MergeMarkerControl
        issueId="i1"
        mergedAt={null}
        suggestedTarget="ISS-38"
        landingShape="outside_git"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
  };
  const submit = () => {
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
  };

  it("asks where the work landed, as a URL, a CMS entry or a storefront resource", () => {
    open();
    expect(screen.getByText(/the live URL, the CMS entry or the storefront resource/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/)).toHaveValue("");
  });

  it("sends the answer as the landing, and no branch target", () => {
    open();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/), {
      target: { value: "  https://mowmentbrand.com/products/linen-tee  " },
    });
    submit();
    expect(mark).toHaveBeenCalledWith(
      { landing: "https://mowmentbrand.com/products/linen-tee" },
      expect.anything(),
    );
  });

  it("closes the form once the mark is answered", () => {
    mark.mockImplementation((_body, options) => options?.onSuccess?.());
    open();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/), {
      target: { value: "https://mowmentbrand.com/products/linen-tee" },
    });
    submit();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a refused mark's form open, with what was typed and the refusal in it", () => {
    const typed = "https://mowmentbrand.com/products/linen-tee";
    mark.mockImplementation((_body, options) =>
      options?.onError?.(
        new ApiError(422, "core sentence", "MARK_ALREADY_STANDS", {
          heldLanding: "https://mowmentbrand.com/prodcts/linen-tee",
        }),
      ),
    );
    open();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/), {
      target: { value: typed },
    });
    submit();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/)).toHaveValue(typed);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("https://mowmentbrand.com/prodcts/linen-tee");
    expect(alert).toHaveTextContent("press Unmark");
  });

  it("keeps a landing past 2000 characters whole, says the limit, and will not send it", () => {
    open();
    const long = `https://shop.example.com/${"x".repeat(2000)}`;
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/), {
      target: { value: long },
    });
    expect(screen.getByPlaceholderText(/https:\/\/shop\.example\.com/)).toHaveValue(long);
    expect(screen.getByRole("alert")).toHaveTextContent("At most 2000 characters");
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    expect(buttons[buttons.length - 1]).toBeDisabled();
    submit();
    expect(mark).not.toHaveBeenCalled();
  });

  it("will not send a mark that names no landing", () => {
    open();
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    expect(buttons[buttons.length - 1]).toBeDisabled();
  });
});

describe("MergeMarkerControl on a project that lands in git keeps its form", () => {
  it("prefills the branch target and sends no landing", () => {
    render(
      <MergeMarkerControl issueId="i1" mergedAt={null} suggestedTarget="ISS-791" landingShape="git" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    expect(screen.getByPlaceholderText(/branch or change request/)).toHaveValue("ISS-791");
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    expect(mark).toHaveBeenCalledWith({ target: "ISS-791" }, expect.anything());
  });

  it("explains the claim in the words it always had, never the landing's", () => {
    render(
      <MergeMarkerControl issueId="i1" mergedAt={null} suggestedTarget="ISS-791" landingShape="git" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    expect(screen.getByText(/This is a claim that the code shipped, not a date field/)).toBeInTheDocument();
    expect(screen.queryByText(/lands outside git/)).toBeNull();
  });

  it("takes a target past 200 characters whole, as it did before", () => {
    render(
      <MergeMarkerControl issueId="i1" mergedAt={null} suggestedTarget="ISS-791" landingShape="git" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark merged" }));
    const long = `feature/${"y".repeat(240)}`;
    fireEvent.change(screen.getByPlaceholderText(/branch or change request/), { target: { value: long } });
    expect(screen.getByPlaceholderText(/branch or change request/)).toHaveValue(long);
    const buttons = screen.getAllByRole("button", { name: "Mark merged" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    expect(mark).toHaveBeenCalledWith({ target: long }, expect.anything());
  });
});
