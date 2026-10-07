// The decisions panel draws the loader while its query loads, the error (Retry only where a second
// attempt can help) when it fails, and an empty list in words. Pinned before the loading/error
// branches moved onto QueryBoundary: no wrapper, no extra height around any of them.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

const refetch = vi.fn();
const q = { isLoading: false, isError: false, data: undefined as unknown, error: null as unknown, refetch };
vi.mock("../hooks", () => ({ useEntityDecisions: () => q, usePostEntityComment: () => ({ mutate: vi.fn(), isPending: false, isError: false }) }));

import { DecisionsPanel } from "./decisions-panel";

const mount = () => render(<DecisionsPanel projectId="p" scope="workflow" targetRef="r" />);
beforeEach(() => {
  refetch.mockClear();
  Object.assign(q, { isLoading: false, isError: false, data: undefined, error: null });
});
afterEach(cleanup);

describe("the decisions panel's states", () => {
  it("draws the loader with its label and nothing around it", () => {
    q.isLoading = true;
    const { container } = mount();
    expect(screen.getByText("loading decisions…")).toBeTruthy();
    expect(container.querySelector('[class*="min-h-"]')).toBeNull();
  });

  it("draws a retryable failure with a Retry that refetches", () => {
    Object.assign(q, { isError: true, error: new Error("boom") });
    const { container } = mount();
    expect(container.textContent).toContain("boom");
    expect(container.querySelector('[class*="min-h-"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("draws a failure no second attempt can fix without a Retry", () => {
    Object.assign(q, { isError: true, error: new ApiError(403, "not yours", "FORBIDDEN") });
    mount();
    expect(screen.queryByRole("button", { name: /retry|try again/i })).toBeNull();
  });

  it("reads an empty list in words and keeps the composer", () => {
    q.data = { comments: [] };
    mount();
    expect(screen.getByText("No decisions recorded yet.")).toBeTruthy();
    expect(screen.getByTestId("decisions-panel")).toBeTruthy();
  });
});
