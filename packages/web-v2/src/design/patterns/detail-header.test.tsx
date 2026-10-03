// @vitest-environment jsdom
//
// "← Issues" goes back to the list view the page was opened from — its mode, filters and peek —
// and to the plain list when the page was reached any other way.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DetailHeader, rememberListOrigin, useListOrigin } from "./detail-header";

expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => sessionStorage.clear());

describe("list origin", () => {
  it("returns to the remembered list view", () => {
    window.history.replaceState(null, "", "/projects/p/issues?group=module&peek=ISS-4");
    rememberListOrigin("issues");
    const { result } = renderHook(() => useListOrigin("issues", "/projects/p/issues"));
    expect(result.current).toBe("/projects/p/issues?group=module&peek=ISS-4");
  });

  it("ignores a remembered view of another project's list", () => {
    window.history.replaceState(null, "", "/projects/other/issues?group=waves");
    rememberListOrigin("issues");
    const { result } = renderHook(() => useListOrigin("issues", "/projects/p/issues"));
    expect(result.current).toBe("/projects/p/issues");
  });
});

describe("DetailHeader", () => {
  it("names the back control after where it goes and shows key, title and action", () => {
    render(<DetailHeader back={{ href: "/projects/p/issues", label: "Issues" }} itemKey="ISS-4" title="Fix it" action={<button type="button">Approve</button>} />);
    const back = screen.getByTestId("detail-back");
    expect(back).toHaveTextContent("Issues");
    expect(back.getAttribute("href")).toBe("/projects/p/issues");
    expect(screen.getByText("ISS-4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });
});
