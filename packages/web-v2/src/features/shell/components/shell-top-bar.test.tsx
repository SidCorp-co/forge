// The top bar every page sits under (ISS-956): its bottom edge is a region line, the lighter of the
// two line tokens, never the old darker border; Feedback stands on every page; and the Ask Agent toggle
// reads pressed while the panel is open and calls back when pressed.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBarSlotProvider } from "@/design";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ShellTopBar } from "./shell-top-bar";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bar = (chatOpen: boolean, onToggleChat = () => {}) => {
  fakeCore((call) => (call.path === "/version" ? { body: { version: "0.4.0" } } : undefined));
  const view = renderWithQuery(
    <TopBarSlotProvider>
      <ShellTopBar chatOpen={chatOpen} onToggleChat={onToggleChat} />
    </TopBarSlotProvider>,
  );
  return view.container.querySelector("header") as HTMLElement;
};

describe("the shell's top bar", () => {
  it("draws its bottom edge as a region line, not the darker border it had", () => {
    const header = bar(false);
    expect(header).toHaveClass("border-b", "border-line-region");
    expect(header.className).not.toMatch(/(^|\s)border-line(\s|$)/);
  });

  it("carries Feedback, and an Ask Agent toggle that reads pressed while the panel is open", () => {
    const onToggle = vi.fn();
    bar(true, onToggle);
    const ask = screen.getByRole("button", { pressed: true });
    fireEvent.click(ask);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /feedback/i })).toBeTruthy();
  });
});
