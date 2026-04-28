import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

let mockActiveProject: string | null = null;
vi.mock("@/stores/app-store", () => ({
  useAppStore: (selector: any) => {
    const state = { activeProject: mockActiveProject };
    return selector ? selector(state) : state;
  },
}));

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
  const preventDefaultSpy = vi.spyOn(event, "preventDefault");
  window.dispatchEvent(event);
  return preventDefaultSpy;
}

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockActiveProject = null;
  });

  it("Ctrl+1 navigates to / and calls preventDefault", () => {
    renderHook(() => useKeyboardShortcuts());
    const preventSpy = fireKey("1", { ctrlKey: true });
    expect(preventSpy).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("Ctrl+2 with activeProject navigates to issues and calls preventDefault", () => {
    mockActiveProject = "my-proj";
    renderHook(() => useKeyboardShortcuts());
    const preventSpy = fireKey("2", { ctrlKey: true });
    expect(preventSpy).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/project/my-proj/issues");
  });

  it("Ctrl+2 without activeProject does not navigate", () => {
    renderHook(() => useKeyboardShortcuts());
    fireKey("2", { ctrlKey: true });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("Ctrl+3 with activeProject navigates to board", () => {
    mockActiveProject = "my-proj";
    renderHook(() => useKeyboardShortcuts());
    const preventSpy = fireKey("3", { ctrlKey: true });
    expect(preventSpy).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/project/my-proj/board");
  });

  it("Ctrl+4 with activeProject navigates to agent", () => {
    mockActiveProject = "my-proj";
    renderHook(() => useKeyboardShortcuts());
    const preventSpy = fireKey("4", { ctrlKey: true });
    expect(preventSpy).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/project/my-proj/agent");
  });

  it("Ctrl+5 navigates to /settings and calls preventDefault", () => {
    renderHook(() => useKeyboardShortcuts());
    const preventSpy = fireKey("5", { ctrlKey: true });
    expect(preventSpy).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/settings");
  });

  it("Ctrl+9 (unhandled combo) does NOT navigate", () => {
    renderHook(() => useKeyboardShortcuts());
    fireKey("9", { ctrlKey: true });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("Ctrl+6 (unhandled combo) does NOT navigate", () => {
    renderHook(() => useKeyboardShortcuts());
    fireKey("6", { ctrlKey: true });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("Escape dispatches forge:close-modal event", () => {
    const handler = vi.fn();
    window.addEventListener("forge:close-modal", handler);
    renderHook(() => useKeyboardShortcuts());
    fireKey("Escape");
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener("forge:close-modal", handler);
  });

  it("plain number keys without Ctrl do not navigate", () => {
    renderHook(() => useKeyboardShortcuts());
    fireKey("1");
    fireKey("5");
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
