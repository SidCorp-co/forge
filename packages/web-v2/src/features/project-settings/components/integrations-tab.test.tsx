// @vitest-environment jsdom
//
// ISS-1421 r4 repair 1 — the no-live-target refusal links here with `?add=live-deploy-target`. The
// landing must do what the refusal says: with no connection, start one Forge can deploy to; with
// one, open the share form on it with Deploy target and Live already chosen. The status list above
// it is flush rows in plain words: no transport line, no empty sync line.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

/** What the list answers a project admin who is a plain member of the organization. */
const ADMIN_MAY = {
  connect: true,
  whoConnects: "an admin of this project",
  grantBoxAgents: false,
  whoGrantsBoxAgents: "an owner or admin of this project's organization",
  changeProjectSettings: false,
  whoChangesProjectSettings: "an owner or admin of this project's organization",
};

const state = {
  search: "?tab=integrations&add=live-deploy-target",
  connections: [] as Array<Record<string, unknown>>,
  bindings: [] as Array<Record<string, unknown>>,
  fetchingBindings: false,
  may: ADMIN_MAY as Record<string, unknown>,
};

const CARDS = [
  {
    key: "github",
    label: "GitHub",
    status: "not_configured",
    detail: "No GitHub App is set up for this project.",
    lastSyncAt: null,
    configured: false,
    meta: { transport: "unknown" },
  },
  {
    key: "coolify",
    label: "Coolify",
    status: "not_configured",
    detail: "Not set up for this project.",
    lastSyncAt: null,
    configured: false,
  },
  {
    key: "postgres",
    label: "Postgres",
    status: "connected",
    detail: "The core database answers.",
    lastSyncAt: null,
    configured: true,
  },
];

/** What a write to the address replaced it with, as the page's own history would hold it. */
const replaced: string[] = [];
vi.mock("@/lib/utils/use-location-search", () => ({
  useLocationSearch: () => state.search,
  replaceLocationSearch: (url: string) => {
    replaced.push(url);
    state.search = new URL(url, "http://localhost").search;
    window.history.replaceState(null, "", url);
  },
}));
vi.mock("@/features/integrations/hooks", () => ({
  useConnections: () => ({ data: { items: state.connections }, isLoading: false }),
  useBindExistingConnection: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useProjectIntegrationActs: () => state.may,
  useIntegrationsList: () => ({
    data: { items: state.bindings },
    isLoading: false,
    isError: false,
    isFetching: state.fetchingBindings,
  }),
  useIntegrationsStatus: () => ({
    data: { cards: CARDS },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/integrations/components/mcp-servers-panel", () => ({
  McpServersPanel: () => null,
}));
vi.mock("@/features/integrations/components/connection-detail-drawer", () => ({
  ConnectionDetailDrawer: ({
    card,
    focus,
    onClose,
  }: { card: { key: string } | null; focus?: string | null; onClose: () => void }) =>
    card ? (
      <div data-testid="drawer">
        {`${card.key}${focus ? ` at ${focus}` : ""}`}
        <button type="button" onClick={onClose}>
          Close drawer
        </button>
      </div>
    ) : null,
}));

const { IntegrationsTab } = await import("./integrations-tab");

afterEach(() => {
  cleanup();
  replaced.length = 0;
  window.history.replaceState(null, "", "/");
  state.search = "?tab=integrations&add=live-deploy-target";
  state.connections = [];
  state.bindings = [];
  state.fetchingBindings = false;
  state.may = ADMIN_MAY;
});

function coolify(id: string): Record<string, unknown> {
  return {
    id,
    ownerType: "user",
    ownerId: "u-1",
    provider: "coolify",
    displayName: "Ops Coolify",
    config: {},
    active: true,
    lastHealthStatus: "ok",
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    access: { reach: "owner", canManage: true, ownerName: null },
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
  };
}

describe("the page the no-live-target link opens", () => {
  it("with no connection, offers to connect a provider Forge deploys to, and opens its setup", () => {
    render(<IntegrationsTab projectId="p-1" />);
    const none = screen.getByTestId("no-connection");
    expect(none).toHaveTextContent("You have no connection to share yet.");
    expect(none).not.toHaveTextContent("Integrations hub");

    fireEvent.click(within(none).getByRole("button", { name: "Connect Coolify" }));
    // It opens at Live, the stage the refusal asked for.
    expect(screen.getByTestId("drawer")).toHaveTextContent("coolify:live");
  });

  it("with one connection, opens the share form on it with Deploy target and Live chosen", () => {
    state.connections = [coolify("c-1")];
    render(<IntegrationsTab projectId="p-1" />);

    expect(screen.getByText(/^Ops Coolify · /)).toBeInTheDocument();
    expect(screen.getByText("Deploy target — somewhere Forge deploys to")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Live/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Preview/ })).not.toBeChecked();
  });

  it("without the link, chooses nothing for the person", () => {
    state.search = "?tab=integrations";
    state.connections = [coolify("c-1")];
    render(<IntegrationsTab projectId="p-1" />);
    expect(screen.queryByRole("checkbox", { name: /Live/ })).toBeNull();
    expect(screen.queryByText(/^Ops Coolify · /)).toBeNull();
  });
});

// ISS-1339 r2 — the readiness gap "a live binding declares no verify probe" links here with
// `?field=verify-probe`. The landing opens the drawer of the binding the gap is about, at Live, on
// its Verify probe section — not the tab's top, which left a person to find the binding themselves.
describe("the page the verify-probe link opens", () => {
  function live(provider: string, verify?: unknown): Record<string, unknown> {
    const config = verify === undefined ? {} : { verify };
    return { id: `b-${provider}`, provider, role: "deploy", stages: ["live"], active: true, config, bindingConfig: config };
  }
  const PROBE = { probes: [{ url: "https://api.example.com/version", commitPath: "sourceCommit" }] };

  it("opens the live binding that declares no probe, on its Verify probe section", () => {
    state.search = "?tab=integrations&field=verify-probe";
    state.bindings = [live("coolify")];
    render(<IntegrationsTab projectId="p-1" />);
    expect(screen.getByTestId("drawer")).toHaveTextContent("coolify:live at verify-probe");
  });

  it("passes over a live binding whose probe a release reads, to the one whose probe it cannot", () => {
    state.search = "?tab=integrations&field=verify-probe";
    CARDS.push({ key: "epodsystem", label: "Epodsystem", status: "connected", detail: "", lastSyncAt: null, configured: true });
    try {
      state.bindings = [live("coolify", PROBE), live("epodsystem", { probes: [{ url: "health" }] })];
      render(<IntegrationsTab projectId="p-1" />);
      expect(screen.getByTestId("drawer")).toHaveTextContent("epodsystem:live at verify-probe");
    } finally {
      CARDS.pop();
    }
  });

  it("still lands when a cached empty list is refreshed into the binding the link is about", () => {
    state.search = "?tab=integrations&field=verify-probe";
    state.fetchingBindings = true;
    const { rerender } = render(<IntegrationsTab projectId="p-1" />);
    expect(screen.queryByTestId("drawer")).toBeNull();

    state.bindings = [live("coolify")];
    state.fetchingBindings = false;
    rerender(<IntegrationsTab projectId="p-1" />);
    expect(screen.getByTestId("drawer")).toHaveTextContent("coolify:live at verify-probe");
  });

  it("passes over a binding that serves only Preview", () => {
    state.search = "?tab=integrations&field=verify-probe";
    state.bindings = [{ ...live("coolify"), stages: ["preview"] }];
    render(<IntegrationsTab projectId="p-1" />);
    expect(screen.queryByTestId("drawer")).toBeNull();
  });

  it("without the link, opens nothing", () => {
    state.search = "?tab=integrations";
    state.bindings = [live("coolify")];
    render(<IntegrationsTab projectId="p-1" />);
    expect(screen.queryByTestId("drawer")).toBeNull();
  });

  // ISS-1339 r3, judge-99: the query stayed after the drawer it opened was closed, so a reload
  // opened the drawer again.
  function arrive() {
    state.search = "?tab=integrations&field=verify-probe";
    window.history.replaceState(null, "", "/stub/settings?tab=integrations&field=verify-probe#top");
  }

  it("drops field from the address when the drawer it opened closes, keeping the rest", () => {
    arrive();
    state.bindings = [live("coolify")];
    const { rerender } = render(<IntegrationsTab projectId="p-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(replaced).toEqual(["/stub/settings?tab=integrations#top"]);
    expect(window.location.search).toBe("?tab=integrations");
    rerender(<IntegrationsTab projectId="p-1" />);
    expect(screen.queryByTestId("drawer")).toBeNull();
  });

  it("opens no drawer on a reload of the address the close left", () => {
    arrive();
    state.bindings = [live("coolify")];
    render(<IntegrationsTab projectId="p-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    cleanup();
    render(<IntegrationsTab projectId="p-1" />);
    expect(screen.queryByTestId("drawer")).toBeNull();
  });

  it("leaves an address that carries no probe landing as it was", () => {
    state.search = "?tab=integrations";
    window.history.replaceState(null, "", "/stub/settings?tab=integrations");
    render(<IntegrationsTab projectId="p-1" />);
    fireEvent.click(screen.getByText("Coolify"));
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(replaced).toEqual([]);
  });

  // Closing over an unsaved edit: the drawer's Discard, then the leave guard steps Back off its own
  // history entry onto the page's, which still carries the link's query.
  it("drops field again when the leave guard's Back brings it back, and opens nothing", () => {
    arrive();
    state.bindings = [live("coolify")];
    const { rerender } = render(<IntegrationsTab projectId="p-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    rerender(<IntegrationsTab projectId="p-1" />);
    arrive();
    rerender(<IntegrationsTab projectId="p-1" />);
    expect(screen.queryByTestId("drawer")).toBeNull();
    expect(replaced).toEqual(["/stub/settings?tab=integrations#top", "/stub/settings?tab=integrations#top"]);
    expect(window.location.search).toBe("?tab=integrations");
  });

  it("lands again when the link is followed from another tab, which mounts the tab anew", () => {
    arrive();
    state.bindings = [live("coolify")];
    render(<IntegrationsTab projectId="p-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    cleanup();
    arrive();
    render(<IntegrationsTab projectId="p-1" />);
    expect(screen.getByTestId("drawer")).toHaveTextContent("coolify:live at verify-probe");
  });
});

describe("the status list on the Integrations tab", () => {
  it("is flush rows in plain words, with no transport or empty sync line", () => {
    state.search = "?tab=integrations";
    render(<IntegrationsTab projectId="p-1" />);
    const rows = screen.getByTestId("integration-rows");
    expect(rows.tagName).toBe("UL");
    // One flush row per provider: list items, not a grid of tiles.
    expect([...rows.children].map((c) => c.tagName)).toEqual(CARDS.map(() => "LI"));
    expect(rows).not.toHaveTextContent(/transport/i);
    expect(rows).not.toHaveTextContent(/no sync data/i);
    expect(rows).toHaveTextContent("No GitHub App is set up for this project.");
  });
});

// ISS-1421 r27: the share form said "Only the project owner can share" from the org role the web
// guessed at, while core lets any admin of the project share; it now reads the list's `may`.
describe("who the share form is offered to", () => {
  it("tells a plain member of the project who may share, from the rule core refuses by", () => {
    state.may = { ...ADMIN_MAY, connect: false };
    state.connections = [coolify("c-1")];
    render(<IntegrationsTab projectId="p-1" />);
    expect(
      screen.getByText("Only an admin of this project can share a connection with this project."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/project owner/)).toBeNull();
  });

  it("offers the form to an admin of the project who is a plain member of the organization", () => {
    state.connections = [coolify("c-1")];
    render(<IntegrationsTab projectId="p-1" />);
    expect(screen.queryByText(/can share a connection with this project/)).toBeNull();
  });

  it("offers no connection the reader does not manage, which the share door refuses", () => {
    state.search = "?tab=integrations&add=live-deploy-target";
    state.connections = [
      { ...coolify("c-org"), ownerType: "org", displayName: "Org Coolify", access: { reach: "org", canManage: false, ownerName: "Northwind" } },
    ];
    render(<IntegrationsTab projectId="p-1" />);
    expect(screen.getByTestId("no-connection")).toBeInTheDocument();
    expect(screen.queryByText(/Org Coolify/)).toBeNull();
  });
});
