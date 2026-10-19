// @vitest-environment jsdom
//
// ISS-1421 r10, criterion 134 — judge-46 read "This project's credential is handed to the runner box,
// and the agent calls the provider directly." under the agents switch of a Sentry binding turned off,
// directly below the row's own "It is set up and turned off, so agents do not get its MCP server".

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAccess, AgentPathKind } from "@forge/contracts";
import { AgentAccessControl, TURNED_OFF_COPY } from "./agent-access-control";

expect.extend(matchers);

vi.mock("../hooks", () => ({
  useUpdateProviderIntegration: () => ({ mutate: vi.fn() }),
  useIsOrgAdmin: () => true,
}));

afterEach(cleanup);

const LIVE = /handed to the runner box|calls the provider directly|makes the call|hands the project's credential/;

function show(active: boolean, agentAccess: AgentAccess, agentPathKind: AgentPathKind) {
  render(
    <AgentAccessControl
      projectId="p1"
      binding={{ id: "b1", active, agentAccess, agentPathKind }}
      canEdit
    />,
  );
  return document.body.textContent ?? "";
}

describe("the agents switch on a binding that is turned off", () => {
  it.each([
    ["direct-mcp", "all"],
    ["direct-mcp", "none"],
    ["core-mediated", "all"],
    ["core-mediated", "none"],
  ] as const)("says agents get nothing from a %s binding, granted %s, and nothing live", (kind, access) => {
    const text = show(false, access, kind);
    expect(text).toContain("Agents get nothing from it while it is turned off.");
    expect(text).not.toMatch(LIVE);
    expect(screen.getByText(access === "all" ? TURNED_OFF_COPY.granted : TURNED_OFF_COPY.withheld)).toBeInTheDocument();
  });

  // Seen on the after-shot: the line saying who may grant it read as a credential already sent.
  it("says who may grant it as what granting would do, for a caller who may not", async () => {
    vi.resetModules();
    vi.doMock("../hooks", () => ({
      useUpdateProviderIntegration: () => ({ mutate: vi.fn() }),
      useIsOrgAdmin: () => false,
    }));
    const { AgentAccessControl: Control } = await import("./agent-access-control");
    render(
      <Control projectId="p1" binding={{ id: "b1", active: false, agentAccess: "all", agentPathKind: "direct-mcp" }} canEdit />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Granting this sends the integration's credential to the runner");
    expect(text).not.toMatch(/credential is (?:sent|handed)/);
    vi.doUnmock("../hooks");
  });

  it("still says what the grant does on a binding that is on", () => {
    expect(show(true, "all", "direct-mcp")).toMatch(/handed to the runner box/);
  });
});
