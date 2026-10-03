// @vitest-environment jsdom
//
// A full page's views are tabs held in `?tab=`; the first is the default and is never written.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailTabs, useUrlTab } from "./detail-tabs";

expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => window.history.replaceState(null, "", "/issues/ISS-1"));

const TABS = ["overview", "criteria", "activity"] as const;

describe("useUrlTab", () => {
  it("defaults to the first tab, writes the others and clears the default", () => {
    const { result } = renderHook(() => useUrlTab(TABS));
    expect(result.current[0]).toBe("overview");
    act(() => result.current[1]("criteria"));
    expect(window.location.search).toBe("?tab=criteria");
    expect(result.current[0]).toBe("criteria");
    act(() => result.current[1]("overview"));
    expect(window.location.search).toBe("");
  });

  it("reads an unknown tab as the default", () => {
    window.history.replaceState(null, "", "/issues/ISS-1?tab=nope");
    const { result } = renderHook(() => useUrlTab(TABS));
    expect(result.current[0]).toBe("overview");
  });
});

describe("DetailTabs", () => {
  it("labels each tab with its count and reports a switch", () => {
    const onChange = vi.fn();
    render(
      <DetailTabs
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "criteria", label: "Criteria", count: 4 },
        ]}
        value="overview"
        onChange={onChange}
      />,
    );
    const crit = screen.getByRole("tab", { name: /Criteria/ });
    expect(crit).toHaveTextContent("Criteria4");
    fireEvent.click(crit);
    expect(onChange).toHaveBeenCalledWith("criteria");
  });
});
