// @vitest-environment jsdom
//
// ISS-1229 r36, judge-97: a viewer-only reader was offered "Ask agent" by a panel that let them only read.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentPanelName } from "@/features/conversations/membership";
import { TopBar } from "./top-bar";

afterEach(cleanup);

describe("the top bar's agent action", () => {
  it("is Ask agent where the reader may start a room", () => {
    render(<TopBar onAskAgent={vi.fn()} askAgentLabel={agentPanelName(true)} onNewIssue={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Ask agent" })).toBeTruthy();
  });

  it("is Conversations where the reader may only read, never Ask agent", () => {
    render(<TopBar onAskAgent={vi.fn()} askAgentLabel={agentPanelName(false)} onNewIssue={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Conversations" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask agent" })).toBeNull();
    expect(screen.queryByText("Ask agent")).toBeNull();
  });
});
