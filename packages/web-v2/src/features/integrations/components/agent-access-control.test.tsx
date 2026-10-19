// @vitest-environment jsdom
//
// ISS-1421 r10, criterion 134 — judge-46 read "This project's credential is handed to the runner box,
// and the agent calls the provider directly." under the agents switch of a Sentry binding turned off,
// directly below the row's own "It is set up and turned off, so agents do not get its MCP server".

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAccess, AgentPathKind } from "@forge/contracts";
import { AgentAccessControl, turnedOffCopy } from "./agent-access-control";

expect.extend(matchers);

vi.mock("../hooks", () => ({
  useUpdateProviderIntegration: () => ({ mutate: vi.fn() }),
  useIsOrgAdmin: () => true,
}));

afterEach(cleanup);

const LIVE = /handed to the runner box|calls the provider directly|makes the call|hands the project's credential/;

function show(
  active: boolean,
  agentAccess: AgentAccess,
  agentPathKind: AgentPathKind,
  {
    bindingActive = active,
    connectionActive = true,
    readFrom,
  }: { bindingActive?: boolean; connectionActive?: boolean; readFrom?: "drawer" | "panel" } = {},
) {
  render(
    <AgentAccessControl
      projectId="p1"
      binding={{ id: "b1", active, bindingActive, connectionActive, agentAccess, agentPathKind }}
      canEdit
      {...(readFrom ? { readFrom } : {})}
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
    const copy = turnedOffCopy("binding", "drawer");
    expect(screen.getByText(access === "all" ? copy.granted : copy.withheld)).toBeInTheDocument();
  });

  // r11: judge-52 read "Turning this on takes effect once it is turned back on", two switches called
  // "on" and neither said where turning it back on happens.
  it.each([
    ["drawer", "binding", "all", "They may use it once Enabled in this drawer is switched back on."],
    ["drawer", "binding", "none", "A grant takes effect once Enabled in this drawer is switched back on."],
    [
      "panel",
      "binding",
      "all",
      "They may use it once Enabled in its drawer, opened from the list above, is switched back on.",
    ],
    [
      "drawer",
      "credential",
      "none",
      "A grant takes effect once Enable credential in this drawer turns its shared credential back on.",
    ],
    [
      "panel",
      "credential",
      "all",
      "They may use it once Enable credential in its drawer, opened from the list above, turns its shared credential back on.",
    ],
    [
      "drawer",
      "both",
      "all",
      "They may use it once you press Enable credential and switch Enabled back on, both in this drawer.",
    ],
    [
      "panel",
      "both",
      "none",
      "A grant takes effect once you press Enable credential and switch Enabled back on, both in its drawer, opened from the list above.",
    ],
  ] as const)("names the switch that turns it back on, read from the %s, turned off at the %s, granted %s", (from, tier, access, said) => {
    const text = show(false, access, "direct-mcp", {
      bindingActive: tier === "credential",
      connectionActive: tier === "binding",
      readFrom: from,
    });
    expect(text).toContain(said);
    expect(text).not.toMatch(/Turning this on|turned back on\./);
    // r12: judge-55 read the both-off line naming Enabled alone, never the control for the credential.
    if (tier !== "binding") expect(text).toContain("Enable credential");
    if (tier !== "credential") expect(text).toMatch(/\bEnabled\b/);
    for (const sentence of text.match(/[A-Z][^.]*\./g) ?? []) {
      expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(25);
    }
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
      <Control
        projectId="p1"
        binding={{
          id: "b1",
          active: false,
          bindingActive: false,
          connectionActive: true,
          agentAccess: "all",
          agentPathKind: "direct-mcp",
        }}
        canEdit
      />,
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
