// @vitest-environment jsdom
//
// ISS-1421 r10, criterion 134 — judge-46 read "This project's credential is handed to the runner box,
// and the agent calls the provider directly." under the agents switch of a Sentry binding turned off,
// directly below the row's own "It is set up and turned off, so agents do not get its MCP server".

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAccess, AgentPathKind, BindingActs } from "@forge/contracts";
import { AgentAccessControl, turnedOffCopy } from "./agent-access-control";

expect.extend(matchers);

vi.mock("../hooks", () => ({
  useUpdateProviderIntegration: () => ({ mutate: vi.fn() }),
}));

/** What core answers a project admin who manages the connection and may grant a box-held one. */
const ALL: BindingActs = {
  change: true,
  saveKey: true,
  turnOn: true,
  grantAgents: true,
  whoChanges: "an admin of this project",
  whoSavesKey: "its owner or an admin of a project it is shared with",
  whoTurnsOn: "its owner",
  whoGrantsAgents: "an owner or admin of this project's organization",
};
let acts: BindingActs = ALL;

afterEach(() => {
  cleanup();
  acts = ALL;
});

const LIVE = /handed to the runner box|calls the provider directly|makes the call|hands the project's credential/;

function show(
  active: boolean,
  agentAccess: AgentAccess,
  agentPathKind: AgentPathKind,
  {
    bindingActive = active,
    connectionActive = true,
    hasSecrets = true,
    readFrom,
  }: {
    bindingActive?: boolean;
    connectionActive?: boolean;
    hasSecrets?: boolean;
    readFrom?: "drawer" | "panel";
  } = {},
) {
  render(
    <AgentAccessControl
      projectId="p1"
      binding={{ id: "b1", connectionId: "c1", active, bindingActive, connectionActive, hasSecrets, agentAccess, agentPathKind, acts }}
      {...(readFrom ? { readFrom } : {})}
    />,
  );
  return document.body.textContent ?? "";
}

// ISS-1421 r26, judge-105 (283b): "once you press Enable credential" was read by a project admin the
// connection's routes refuse; the drawer no longer shows them that button, so the line names who does.
describe("the agents line for a reader who may not turn the credential on (criterion 296)", () => {
  it.each([
    ["credential", true, "A grant takes effect once its owner turns its shared credential back on."],
    [
      "both",
      false,
      "A grant takes effect once its owner turns its shared credential back on and Enabled in this drawer is switched back on.",
    ],
  ] as const)("names who turns it on where the %s is off", (_tier, bindingActive, line) => {
    acts = { ...ALL, turnOn: false };
    const said = show(false, "none", "core-mediated", { bindingActive, connectionActive: false });
    expect(said).toContain(line);
    expect(said).not.toContain("Enable credential");
  });

  it("names the organization's owners and admins for its connection", () => {
    acts = { ...ALL, turnOn: false, whoTurnsOn: "an owner or admin of the organization that owns it" };
    expect(show(false, "none", "core-mediated", { bindingActive: true, connectionActive: false })).toContain(
      "once an owner or admin of the organization that owns it turns its shared credential back on.",
    );
  });
});

// ISS-1421 r22: a removed connection has no Enable credential, so the line never names one.
describe("the agents line over a removed connection (criterion 228)", () => {
  it("says the removed connection comes back on, never Enable credential", () => {
    const said = show(false, "none", "core-mediated", {
      bindingActive: true,
      connectionActive: false,
      hasSecrets: false,
    });
    expect(said).toContain("once its shared connection, which was removed, is turned back on.");
    expect(said).not.toContain("Enable credential");
  });

  it("names Enabled as well where this project switched it off too", () => {
    const said = show(false, "none", "core-mediated", {
      bindingActive: false,
      connectionActive: false,
      hasSecrets: false,
    });
    expect(said).toContain("which was removed, is turned back on and Enabled in this drawer is switched back on.");
    expect(said).not.toContain("Enable credential");
  });
});

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
  it("says who may grant it as what granting would do, for a caller who may not", () => {
    acts = { ...ALL, grantAgents: false };
    const text = show(false, "all", "direct-mcp", { bindingActive: false });
    expect(text).toContain(
      "Granting this sends the integration's credential to the runner, so only an owner or admin of this project's organization can grant it.",
    );
    expect(text).not.toMatch(/credential is (?:sent|handed)/);
  });

  // ISS-1421 r27 (287, 293): the switch was live for a plain member of the project, whose grant core
  // then refused; it is drawn off and names the admin of the project who may.
  it("is not live for a plain member of the project, and names who may change it", () => {
    acts = {
      ...ALL,
      change: false,
      grantAgents: false,
      saveKey: false,
      turnOn: false,
      whoGrantsAgents: "an admin of this project",
    };
    const text = show(true, "none", "core-mediated");
    expect(screen.getByRole("switch", { name: "Agents on this project may use this" })).toBeDisabled();
    expect(text).toContain("Only an admin of this project can change this.");
  });

  // ISS-1421 r28 (314): the line read the reader's own `change` instead of who core says grants it.
  it("names who core says grants a box-held credential to a reader who may change nothing", () => {
    acts = { ...ALL, change: false, grantAgents: false, saveKey: false, turnOn: false };
    const text = show(true, "none", "direct-mcp");
    expect(screen.getByRole("switch", { name: "Agents on this project may use this" })).toBeDisabled();
    expect(text).toContain(
      "Granting this sends the integration's credential to the runner, so only an owner or admin of this project's organization can grant it.",
    );
    expect(text).not.toContain("Only an admin of this project");
  });

  it("still says what the grant does on a binding that is on", () => {
    expect(show(true, "all", "direct-mcp")).toMatch(/handed to the runner box/);
  });
});
