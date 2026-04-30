import { describe, it, expect, vi } from "vitest";
import { makeKeyboardHandler } from "@/hooks/use-keyboard-shortcuts";
import type { NavigateFunction } from "react-router-dom";

// The hook itself wraps `makeKeyboardHandler` in a useEffect that adds the
// resulting listener to `window`. Tests exercise the factory directly (no
// renderHook) — the wiring is trivial and the routing logic is what matters.
// See vitest.config.ts for why renderHook is currently off-limits in this
// package.

function makeEvent(key: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
}

function navigateSpy(): NavigateFunction {
  return vi.fn() as unknown as NavigateFunction;
}

describe("makeKeyboardHandler", () => {
  it("Ctrl+1 navigates to / and calls preventDefault", () => {
    const navigate = navigateSpy();
    const handler = makeKeyboardHandler(navigate, null);
    const event = makeEvent("1", { ctrlKey: true });
    const preventSpy = vi.spyOn(event, "preventDefault");
    handler(event);
    expect(preventSpy).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("Ctrl+2 with activeProject navigates to issues", () => {
    const navigate = navigateSpy();
    const handler = makeKeyboardHandler(navigate, "my-proj");
    const event = makeEvent("2", { ctrlKey: true });
    const preventSpy = vi.spyOn(event, "preventDefault");
    handler(event);
    expect(preventSpy).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/project/my-proj/issues");
  });

  it("Ctrl+2 without activeProject does not navigate", () => {
    const navigate = navigateSpy();
    const handler = makeKeyboardHandler(navigate, null);
    handler(makeEvent("2", { ctrlKey: true }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("Ctrl+3 with activeProject navigates to board", () => {
    const navigate = navigateSpy();
    const handler = makeKeyboardHandler(navigate, "my-proj");
    const event = makeEvent("3", { ctrlKey: true });
    const preventSpy = vi.spyOn(event, "preventDefault");
    handler(event);
    expect(preventSpy).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/project/my-proj/board");
  });

  it("Ctrl+4 with activeProject navigates to agent", () => {
    const navigate = navigateSpy();
    const handler = makeKeyboardHandler(navigate, "my-proj");
    const event = makeEvent("4", { ctrlKey: true });
    const preventSpy = vi.spyOn(event, "preventDefault");
    handler(event);
    expect(preventSpy).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/project/my-proj/agent");
  });

  it("Ctrl+5 navigates to /settings and calls preventDefault", () => {
    const navigate = navigateSpy();
    const handler = makeKeyboardHandler(navigate, null);
    const event = makeEvent("5", { ctrlKey: true });
    const preventSpy = vi.spyOn(event, "preventDefault");
    handler(event);
    expect(preventSpy).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/settings");
  });

  it("Ctrl+9 (unhandled combo) does NOT navigate", () => {
    const navigate = navigateSpy();
    const handler = makeKeyboardHandler(navigate, "my-proj");
    handler(makeEvent("9", { ctrlKey: true }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("Ctrl+6 (unhandled combo) does NOT navigate", () => {
    const navigate = navigateSpy();
    const handler = makeKeyboardHandler(navigate, "my-proj");
    handler(makeEvent("6", { ctrlKey: true }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("Escape dispatches forge:close-modal event", () => {
    const navigate = navigateSpy();
    const handler = makeKeyboardHandler(navigate, null);
    const closeListener = vi.fn();
    window.addEventListener("forge:close-modal", closeListener);
    handler(makeEvent("Escape"));
    expect(closeListener).toHaveBeenCalledTimes(1);
    window.removeEventListener("forge:close-modal", closeListener);
  });

  it("plain number keys without Ctrl do not navigate", () => {
    const navigate = navigateSpy();
    const handler = makeKeyboardHandler(navigate, null);
    handler(makeEvent("1"));
    handler(makeEvent("5"));
    expect(navigate).not.toHaveBeenCalled();
  });
});
