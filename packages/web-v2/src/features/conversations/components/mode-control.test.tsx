// @vitest-environment jsdom
//
// ISS-1146 — the mode control in the composer's footer: its semantics, its
// blocked option, its narrow form and the label a settled room reads.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModeOffer } from "../types";
import { ConversationModeControl, modePlaceholder } from "./mode-control";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const FREE: AgentModeOffer = { available: true, reason: null };
const BLOCKED: AgentModeOffer = {
  available: false,
  reason: "no box is paired with this project",
};

function renderControl(over: Partial<Parameters<typeof ConversationModeControl>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <ConversationModeControl
      value="assistant"
      onChange={onChange}
      offer={FREE}
      settled={null}
      {...over}
    />,
  );
  return { onChange };
}

describe("the choice, while the room is still empty", () => {
  it("is a radiogroup under one accessible name, not a row of buttons", () => {
    renderControl();
    const group = screen.getByRole("group", { name: "What this conversation talks to" });
    expect(group.tagName).toBe("FIELDSET");
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("marks the picked mode as the checked radio", () => {
    renderControl({ value: "agent", offer: FREE });
    expect(screen.getByRole("radio", { name: /Agent/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Assistant/ })).not.toBeChecked();
  });

  it("picks the other mode when it is chosen", () => {
    const { onChange } = renderControl({ offer: FREE });
    fireEvent.click(screen.getByRole("radio", { name: /Agent/ }));
    expect(onChange).toHaveBeenCalledWith("agent");
  });
});

describe("the blocked option", () => {
  it("stays reachable by keyboard rather than being skipped over", () => {
    renderControl({ offer: BLOCKED });
    expect(screen.getByRole("radio", { name: /Agent/ })).not.toBeDisabled();
  });

  it("opens a panel naming why it is unavailable", () => {
    renderControl({ offer: BLOCKED });
    fireEvent.click(screen.getByRole("radio", { name: /Agent/ }));
    const panel = screen.getByTestId("mode-blocked-panel");
    expect(panel).toHaveTextContent("no box is paired with this project");
  });

  it("offers the way out of it", () => {
    renderControl({ offer: BLOCKED });
    fireEvent.click(screen.getByRole("radio", { name: /Agent/ }));
    expect(screen.getByRole("link", { name: /Pair a box/ })).toHaveAttribute("href", "/pair");
  });

  it("does not pick the mode it could not run", () => {
    const { onChange } = renderControl({ offer: BLOCKED });
    fireEvent.click(screen.getByRole("radio", { name: /Agent/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says a condition is on it before anyone presses it", () => {
    renderControl({ offer: BLOCKED });
    expect(screen.getByTestId("mode-condition-dot")).toBeInTheDocument();
  });

  it("closes the panel on Escape", () => {
    renderControl({ offer: BLOCKED });
    fireEvent.click(screen.getByRole("radio", { name: /Agent/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("mode-blocked-panel")).not.toBeInTheDocument();
  });
});

describe("below 480 pixels of composer width", () => {
  it("becomes one button naming the mode the room is in", () => {
    renderControl({ narrow: true, value: "agent" });
    expect(screen.getByTestId("conversation-mode-menu-trigger")).toHaveTextContent("Agent");
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("opens a menu carrying both modes", () => {
    renderControl({ narrow: true });
    fireEvent.click(screen.getByTestId("conversation-mode-menu-trigger"));
    const menu = screen.getByTestId("conversation-mode-menu");
    expect(menu).toHaveTextContent("Assistant");
    expect(menu).toHaveTextContent("Agent");
  });

  it("still refuses the blocked mode, with the same panel", () => {
    const { onChange } = renderControl({ narrow: true, offer: BLOCKED });
    fireEvent.click(screen.getByTestId("conversation-mode-menu-trigger"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Agent/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("mode-blocked-panel")).toBeInTheDocument();
  });
});

describe("once the room's mode is settled", () => {
  it("says which mode it is in rather than disappearing", () => {
    renderControl({ settled: "agent" });
    expect(screen.getByTestId("conversation-mode-settled")).toHaveTextContent("Agent");
  });

  it("stops pretending to be a control", () => {
    renderControl({ settled: "assistant" });
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByTestId("conversation-mode-menu-trigger")).not.toBeInTheDocument();
  });
});

describe("the placeholder", () => {
  it("names each mode", () => {
    expect(modePlaceholder("agent")).toContain("Agent");
    expect(modePlaceholder("assistant")).toContain("Assistant");
  });

  it("names neither where the room has not settled one", () => {
    expect(modePlaceholder(null)).toBe("Ask the agent about this project…");
  });
});
