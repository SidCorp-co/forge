// @vitest-environment jsdom
//
// A fixed enum reaches the screen as a sentence-case label in its legend colour; the stored token
// shows only in the tooltip (ISS-67).

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EnumBadge, StatusBadge } from "./enum-badge";

expect.extend(matchers);
afterEach(cleanup);

describe("StatusBadge", () => {
  it("reads a status as words and keeps the raw value for the tooltip", () => {
    render(<StatusBadge family="issue" value="needs_info" />);
    const b = screen.getByTestId("status-badge");
    expect(b).toHaveTextContent("Needs info");
    expect(b.textContent).not.toMatch(/needs_info/);
    expect(b.getAttribute("title")).toMatch(/^needs_info · /);
    expect(b.dataset.tone).toBe("you");
  });

  it("names the step of an issue in progress", () => {
    render(<StatusBadge family="issue" value="in_progress" step="test" />);
    expect(screen.getByTestId("status-badge")).toHaveTextContent("In progress · Test");
  });

  it("draws a tone core derived over the family default", () => {
    render(<StatusBadge family="issue" value="awaiting_release" tone="ready" />);
    expect(screen.getByTestId("status-badge").dataset.tone).toBe("ready");
  });

  it("reads a value no map names as sentence case, never as the token", () => {
    render(<StatusBadge family="session" value="brand_new_state" />);
    const b = screen.getByTestId("status-badge");
    expect(b).toHaveTextContent("Brand new state");
    expect(b.dataset.tone).toBe("neutral");
  });
});

describe("EnumBadge", () => {
  it("is neutral, labelled, and names the field in its tooltip", () => {
    render(<EnumBadge family="priority" value="high" />);
    const b = screen.getByTestId("enum-badge");
    expect(b).toHaveTextContent("High");
    expect(b.getAttribute("title")).toBe("priority: high");
  });

  it("reads a contract kind through its label map", () => {
    render(<EnumBadge family="interfaceType" value="mcp-tools" />);
    expect(screen.getByTestId("enum-badge")).toHaveTextContent("MCP tools");
  });
});
