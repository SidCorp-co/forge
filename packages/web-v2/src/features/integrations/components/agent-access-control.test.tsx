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

  it("still says what the grant does on a binding that is on", () => {
    expect(show(true, "all", "direct-mcp")).toMatch(/handed to the runner box/);
  });
});
