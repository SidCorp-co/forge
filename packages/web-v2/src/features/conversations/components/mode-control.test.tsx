// @vitest-environment jsdom
//
// ISS-1146 — the mode control in the composer's footer: its semantics, its
// blocked option, its narrow form and the label a settled room reads.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModeOffer } from "../types";
import { ComposerWidthContext } from "@/features/chat/components/chat-composer";
import { ConversationModeControl, modePlaceholder } from "./mode-control";

expect.extend(matchers);
afterEach(cleanup);

// next/link forwards its ref to the anchor, and the blocked panel puts the
// keyboard on that anchor — a mock that drops the ref would fail the case it is
// standing in for rather than the code.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ref,
  }: {
    href: string;
    children: React.ReactNode;
    ref?: React.Ref<HTMLAnchorElement>;
  }) => (
    <a href={href} ref={ref}>
      {children}
    </a>
  ),
}));

const FREE: AgentModeOffer = { available: true, reason: null, unbound: null };
const BLOCKED: AgentModeOffer = {
  available: false,
  reason: "this project has no runner paired",
  unbound: null,
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
    expect(panel).toHaveTextContent("Agent needs a paired runner");
    expect(panel).toHaveTextContent("This project has no runner paired.");
  });

  // `/pair` only approves a code the CLI printed and, reached with none, sends
  // the person away again; `/runners` is where "Pair a device" and "Generate
  // code" are. The way out has to land where a pairing can start.
  it("offers the way out of it, on the page a pairing starts from", () => {
    renderControl({ offer: BLOCKED });
    fireEvent.click(screen.getByRole("radio", { name: /Agent/ }));
    const link = screen.getByRole("link", { name: "Pair a runner" });
    expect(link).toHaveAttribute("href", "/runners");
    expect(link).not.toHaveAttribute("href", "/pair");
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

  it("closes the panel on Escape and gives the caret back to the checked mode", () => {
    renderControl({ offer: BLOCKED });
    fireEvent.click(screen.getByRole("radio", { name: /Agent/ }));
    fireEvent.keyDown(screen.getByRole("link", { name: "Pair a runner" }), { key: "Escape" });
    expect(screen.queryByTestId("mode-blocked-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Assistant/ })).toHaveFocus();
  });

  // The dock and the slide-over close on Escape too. A panel that closes and
  // leaves the key unclaimed takes the whole conversation, draft and all, with it.
  it("claims the Escape it closes on, so what it sits in does not also close", () => {
    renderControl({ offer: BLOCKED });
    fireEvent.click(screen.getByRole("radio", { name: /Agent/ }));
    const reachedDocument = vi.fn();
    document.addEventListener("keydown", reachedDocument);
    const notCancelled = fireEvent.keyDown(screen.getByRole("link", { name: "Pair a runner" }), {
      key: "Escape",
    });
    document.removeEventListener("keydown", reachedDocument);
    expect(notCancelled).toBe(false);
    expect(reachedDocument).not.toHaveBeenCalled();
  });

  it("closes when the keyboard leaves it", () => {
    renderControl({ offer: BLOCKED });
    fireEvent.click(screen.getByRole("radio", { name: /Agent/ }));
    fireEvent.blur(screen.getByRole("link", { name: "Pair a runner" }), { relatedTarget: document.body });
    expect(screen.queryByTestId("mode-blocked-panel")).not.toBeInTheDocument();
  });
});

// judge-128 at 9ec61fa: the device was paired already, so "Pair a runner" sent a
// person to a page where it shows as paired and cannot be assigned, under a
// sentence that said to assign it, with its raw id and literal backticks.
describe("the blocked option, where the project's device is paired but not assigned", () => {
  const UNBOUND: AgentModeOffer = {
    available: false,
    reason:
      "Device studio-mac (5f0c1d2e-0000-4000-8000-000000000001) is not bound to project shop, so it has no checkout of it to run in. Assign the device on shop's Runners page, which binds it; to choose the folder it runs in, give the path there or, once it is assigned, run `forge-runner bind shop --path <dir>` on that device. Then try again.",
    unbound: {
      deviceId: "5f0c1d2e-0000-4000-8000-000000000001",
      deviceName: "studio-mac",
      projectSlug: "shop",
    },
  };
  const openPanel = (offer: AgentModeOffer = UNBOUND) => {
    renderControl({ offer });
    fireEvent.click(screen.getByRole("radio", { name: /Agent/ }));
    return screen.getByTestId("mode-blocked-panel");
  };

  it("says what is missing: the device is not assigned to this project", () => {
    const panel = openPanel();
    expect(panel).toHaveTextContent("Agent needs this project's runner");
    expect(panel).toHaveTextContent("studio-mac is paired but not assigned to shop");
    expect(panel).not.toHaveTextContent("Agent needs a paired runner");
  });

  it("links to the project's own Runners page, where the device can be assigned", () => {
    openPanel();
    const link = screen.getByRole("link", { name: "Assign it on shop's Runners page" });
    expect(link).toHaveAttribute("href", "/projects/shop/settings?tab=runners");
    expect(screen.queryByRole("link", { name: "Pair a runner" })).not.toBeInTheDocument();
  });

  it("names the device as the Runners page does, never by its id", () => {
    const panel = openPanel();
    expect(panel).not.toHaveTextContent("5f0c1d2e-0000-4000-8000-000000000001");
  });

  it("shows the bind command as code, with no literal backticks", () => {
    const panel = openPanel();
    const command = panel.querySelector("code");
    expect(command).toHaveTextContent("forge-runner bind shop --path <dir>");
    expect(panel.textContent).not.toContain("`");
  });

  it("says which device without naming one the project does not hold as its default", () => {
    const panel = openPanel({
      ...UNBOUND,
      unbound: { deviceId: "5f0c1d2e-0000-4000-8000-000000000001", deviceName: null, projectSlug: "shop" },
    });
    expect(panel).toHaveTextContent("The device this project picked is paired but not assigned to shop");
    expect(panel).not.toHaveTextContent("5f0c1d2e");
  });

  it("puts the keyboard on the way out, and closes on Escape from it", () => {
    openPanel();
    const link = screen.getByRole("link", { name: "Assign it on shop's Runners page" });
    expect(link).toHaveFocus();
    fireEvent.keyDown(link, { key: "Escape" });
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

  it("puts the keyboard on the option already chosen when it opens", () => {
    renderControl({ narrow: true, value: "agent" });
    fireEvent.click(screen.getByTestId("conversation-mode-menu-trigger"));
    expect(screen.getByRole("menuitemradio", { name: /Agent/ })).toHaveFocus();
  });

  it("moves between the options with the arrow keys", () => {
    renderControl({ narrow: true, value: "assistant" });
    fireEvent.click(screen.getByTestId("conversation-mode-menu-trigger"));
    const assistant = screen.getByRole("menuitemradio", { name: /Assistant/ });
    fireEvent.keyDown(assistant, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: /Agent/ })).toHaveFocus();
  });

  it("closes on Escape and gives the caret back to the button that opened it", () => {
    renderControl({ narrow: true });
    const trigger = screen.getByTestId("conversation-mode-menu-trigger");
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menuitemradio", { name: /Assistant/ }), { key: "Escape" });
    expect(screen.queryByTestId("conversation-mode-menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("claims the Escape it closes on", () => {
    renderControl({ narrow: true });
    fireEvent.click(screen.getByTestId("conversation-mode-menu-trigger"));
    const notCancelled = fireEvent.keyDown(screen.getByRole("menuitemradio", { name: /Assistant/ }), {
      key: "Escape",
    });
    expect(notCancelled).toBe(false);
  });

  it("names the menu it opens", () => {
    renderControl({ narrow: true });
    fireEvent.click(screen.getByTestId("conversation-mode-menu-trigger"));
    expect(screen.getByRole("menu", { name: "What this conversation talks to" })).toBeInTheDocument();
  });

  it("gives the caret back to its button when the blocked panel closes on Escape", () => {
    renderControl({ narrow: true, offer: BLOCKED });
    const trigger = screen.getByTestId("conversation-mode-menu-trigger");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Agent/ }));
    fireEvent.keyDown(screen.getByRole("link", { name: "Pair a runner" }), { key: "Escape" });
    expect(screen.queryByTestId("mode-blocked-panel")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("gives the keyboard the way out when the option it stood on disappears", () => {
    renderControl({ narrow: true, offer: BLOCKED });
    fireEvent.click(screen.getByTestId("conversation-mode-menu-trigger"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Agent/ }));
    expect(screen.getByRole("link", { name: "Pair a runner" })).toHaveFocus();
  });

  it("still refuses the blocked mode, with the same panel", () => {
    const { onChange } = renderControl({ narrow: true, offer: BLOCKED });
    fireEvent.click(screen.getByTestId("conversation-mode-menu-trigger"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Agent/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("mode-blocked-panel")).toBeInTheDocument();
  });
});

describe("the width it reads that form from", () => {
  function atWidth(width: number | null) {
    render(
      <ComposerWidthContext.Provider value={width}>
        <ConversationModeControl
          value="assistant"
          onChange={vi.fn()}
          offer={FREE}
          settled={null}
        />
      </ComposerWidthContext.Provider>,
    );
  }

  it("takes the menu form from the composer's own width, with nothing passed", () => {
    atWidth(420);
    expect(screen.getByTestId("conversation-mode-menu-trigger")).toBeInTheDocument();
  });

  it("keeps the track where the composer is wide enough for it", () => {
    atWidth(896);
    expect(screen.getByRole("group")).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-mode-menu-trigger")).not.toBeInTheDocument();
  });

  it("draws the track until a width has been measured", () => {
    atWidth(null);
    expect(screen.getByRole("group")).toBeInTheDocument();
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

  // ISS-1229 r49, judge-146: the box said "Message Assistant" under a header naming @desk-bot.
  it("names the agents that answer by the handles the header uses", () => {
    expect(modePlaceholder("assistant", ["@desk-bot"])).toBe(
      "Message @desk-bot — it reads this project, not the repository…",
    );
    expect(modePlaceholder("agent", ["@desk-bot", "@ops"])).toBe(
      "Message @desk-bot and @ops — they have the repository and a shell…",
    );
    expect(modePlaceholder(null, ["@desk-bot"])).toBe("Message @desk-bot about this project…");
  });
});
