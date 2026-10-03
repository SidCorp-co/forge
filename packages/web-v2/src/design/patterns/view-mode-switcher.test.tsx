// @vitest-environment jsdom
//
// The list's grouping is one URL param (`?group=`) shared by the header switch and the narrow-screen
// toolbar copy of it.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useViewMode, type ViewMode } from "./view-mode-switcher";

afterEach(cleanup);
beforeEach(() => window.history.replaceState(null, "", "/issues?scope=all"));

const MODES: ViewMode<"attention" | "module" | "waves">[] = [
  { value: "attention", label: "Attention" },
  { value: "module", label: "Module" },
  { value: "waves", label: "Waves" },
];

describe("useViewMode", () => {
  it("reads ?group=, writes a mode beside the other params and drops the default", () => {
    const { result } = renderHook(() => useViewMode(MODES));
    expect(result.current[0]).toBe("attention");
    act(() => result.current[1]("waves"));
    expect(window.location.search).toBe("?scope=all&group=waves");
    act(() => result.current[1]("attention"));
    expect(window.location.search).toBe("?scope=all");
  });

  it("reads a mode the list does not offer as the default", () => {
    window.history.replaceState(null, "", "/issues?group=kanban");
    const { result } = renderHook(() => useViewMode(MODES));
    expect(result.current[0]).toBe("attention");
  });
});
