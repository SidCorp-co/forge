// @vitest-environment jsdom
//
// ISS-1046 — the "Share an existing connection" door, which is where a person
// DECLARES what a binding is for.
//
// Four rules carry it, and each is here because the server or the database
// refuses the same thing one round trip later, with a message that names neither
// the field nor the provider. The role is chosen, never derived from the provider
// — the same ePOD connection is a deploy target on a storefront and a plain
// service on a project that only borrows its MCP. The stage control is UNMOUNTED
// and its value DROPPED under `service`, because a hidden control that still
// submits is how a service binding reaches `integration_bindings_role_stages_chk`
// and comes back a 500. A deploy binding with no stage is refused on the form.
// And a provider with no deploy adapter is refused inline, by name.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationsTab } from "./integrations-tab";

expect.extend(matchers);
afterEach(cleanup);

// The design system's `Select` scrolls the active option into view on open, and
// jsdom implements no such method.
Element.prototype.scrollIntoView = vi.fn();

const bindMutate = vi.fn();
const connectionItems = vi.fn<() => Array<Record<string, unknown>>>();

let orgAdmin = true;
vi.mock("@/features/integrations/hooks", () => ({
  useIsOrgAdmin: () => orgAdmin,
  useConnections: () => ({ data: { items: connectionItems() }, isLoading: false }),
  useBindExistingConnection: () => ({
    mutate: bindMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/features/integrations/components/project-integrations-panel", () => ({
  ProjectIntegrationsPanel: () => null,
}));

const COOLIFY = {
  id: "conn-coolify",
  ownerType: "user",
  ownerId: "u1",
  provider: "coolify",
  displayName: "Deploy box",
  config: {},
  active: true,
  hasSecrets: true,
  lastHealthStatus: null,
  lastHealthAt: null,
  breakerOpenedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const SENTRY = { ...COOLIFY, id: "conn-sentry", provider: "sentry", displayName: "Errors" };

function renderTab() {
  render(<IntegrationsTab projectId="proj-1" canEdit />);
}

/**
 * `Select` is the design system's custom listbox, not a native `<select>`: open
 * the trigger, then click the option by the text a person reads.
 */
function pick(comboboxIndex: number, optionText: RegExp) {
  const trigger = screen.getAllByRole("combobox")[comboboxIndex];
  if (!trigger) throw new Error(`no combobox at index ${comboboxIndex}`);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: optionText }));
}

/** Pick a connection, then optionally a role, through the two `Select`s in order. */
function choose(connectionText: RegExp, role?: "service" | "deploy") {
  pick(0, connectionText);
  if (role === "service") pick(1, /Service — a project-wide facility/);
  if (role === "deploy") pick(1, /Deploy target/);
}

const COOLIFY_OPTION = /Deploy box/;
const SENTRY_OPTION = /Errors/;
const GRANT_SWITCH = /Agents on this project may use this/i;

beforeEach(() => {
  vi.clearAllMocks();
  connectionItems.mockReturnValue([COOLIFY, SENTRY]);
});

describe("ShareExistingCard — the role is declared, not derived", () => {
  it("offers both roles for a provider Forge can deploy to, and neither is preselected from it", () => {
    renderTab();
    choose(COOLIFY_OPTION);

    const roleTrigger = screen.getAllByRole("combobox")[1];
    if (!roleTrigger) throw new Error("no role combobox");
    // A coolify connection is deploy-CAPABLE and still opens as `service`: the
    // provider does not choose, the person does.
    expect(roleTrigger).toHaveTextContent(/Service — a project-wide facility/);

    fireEvent.click(roleTrigger);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Service — a project-wide facility",
      "Deploy target — somewhere Forge deploys to",
    ]);
  });

  it("sends the role the person chose, with the stages they chose", () => {
    renderTab();
    choose(COOLIFY_OPTION, "deploy");
    fireEvent.click(screen.getByRole("checkbox", { name: /Live/ }));
    fireEvent.click(screen.getByRole("button", { name: /Share with this project/i }));

    expect(bindMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "conn-coolify",
        // ISS-1071 — sharing a credential into a project IS a connect, so the body carries the
        // grant the switch showed, closed unless the person opened it. Coolify is core-mediated, so
        // the switch is rendered and its value is submitted.
        body: { projectId: "proj-1", role: "deploy", stages: ["live"], agentAccess: "none" },
      }),
      expect.anything(),
    );
  });

  it("sends no stages at all for a service binding", () => {
    renderTab();
    choose(SENTRY_OPTION, "service");
    fireEvent.click(screen.getByRole("button", { name: /Share with this project/i }));

    const body = bindMutate.mock.calls[0]?.[0]?.body as Record<string, unknown>;
    expect(body).toEqual({ projectId: "proj-1", role: "service", agentAccess: "none" });
    expect(body).not.toHaveProperty("stages");
  });
});

describe("ShareExistingCard — the stage control under `service`", () => {
  it("shows the stage choice only while the role is deploy", () => {
    renderTab();
    choose(COOLIFY_OPTION);
    expect(screen.queryByRole("checkbox", { name: /Preview/ })).toBeNull();

    choose(COOLIFY_OPTION, "deploy");
    expect(screen.getByRole("checkbox", { name: /Preview/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Live/ })).toBeInTheDocument();
  });

  it("clears the stages it hides, so switching back shows nothing selected", () => {
    renderTab();
    choose(COOLIFY_OPTION, "deploy");
    fireEvent.click(screen.getByRole("checkbox", { name: /Live/ }));
    expect(screen.getByRole("checkbox", { name: /Live/ })).toBeChecked();

    choose(COOLIFY_OPTION, "service");
    expect(screen.queryByRole("checkbox", { name: /Live/ })).toBeNull();

    choose(COOLIFY_OPTION, "deploy");
    expect(screen.getByRole("checkbox", { name: /Live/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Preview/ })).not.toBeChecked();
  });

  it("submits no stage key for a binding switched back to service after a stage was picked", () => {
    renderTab();
    choose(COOLIFY_OPTION, "deploy");
    fireEvent.click(screen.getByRole("checkbox", { name: /Live/ }));
    choose(COOLIFY_OPTION, "service");
    fireEvent.click(screen.getByRole("button", { name: /Share with this project/i }));

    expect(bindMutate.mock.calls[0]?.[0]?.body).toEqual({
      projectId: "proj-1",
      role: "service",
      agentAccess: "none",
    });
  });
});

describe("ShareExistingCard — the two refusals, on the form", () => {
  it("refuses a deploy binding with no stage, saying so, and sends nothing", () => {
    renderTab();
    choose(COOLIFY_OPTION, "deploy");
    fireEvent.click(screen.getByRole("button", { name: /Share with this project/i }));

    expect(screen.getByText(/Choose at least one stage/i)).toBeInTheDocument();
    expect(bindMutate).not.toHaveBeenCalled();
  });

  it("refuses a deploy role inline for a provider with no deploy adapter, naming it", () => {
    renderTab();
    choose(SENTRY_OPTION, "deploy");

    expect(screen.getByText(/Forge cannot deploy to Sentry/i)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Preview/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Share with this project/i }));
    expect(bindMutate).not.toHaveBeenCalled();
  });

  it("does not refuse a service binding on that same provider", () => {
    renderTab();
    choose(SENTRY_OPTION, "service");

    expect(screen.queryByText(/Forge cannot deploy to/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Share with this project/i }));
    expect(bindMutate).toHaveBeenCalled();
  });
});

// ISS-1071 / F3, found by review. The grant's tier is not the credential's: a `direct-mcp` grant
// sends a project's credential to a runner box, so `authorizeAgentAccessWrite` takes org admin,
// while a `core-mediated` one stays a project-admin field. The screen used general editability, so
// a project admin who is not an org admin was offered a switch the server answers 403 to.
describe("ShareExistingCard — who is offered the grant", () => {
  afterEach(() => {
    orgAdmin = true;
  });

  it("disables the switch for a direct-MCP provider below org admin, and says who can", () => {
    orgAdmin = false;
    renderTab();
    choose(SENTRY_OPTION, "service");

    // Disabled rather than ABSENT: a control that vanishes reads as "this integration cannot be
    // granted at all", which is a different and wrong answer.
    expect(screen.getByRole("switch", { name: GRANT_SWITCH })).toBeDisabled();
    expect(screen.getByText(/only an organisation owner or admin/i)).toBeInTheDocument();
  });

  it("leaves it writable for a core-mediated provider at the same permission", () => {
    orgAdmin = false;
    renderTab();
    choose(COOLIFY_OPTION, "service");

    expect(screen.getByRole("switch", { name: GRANT_SWITCH })).toBeEnabled();
  });
});
