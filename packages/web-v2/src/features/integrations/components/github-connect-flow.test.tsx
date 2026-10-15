// GitHub on the workspace Integrations page: one Connect GitHub button for the active org, no form;
// an App made before the instance had one is completed rather than joined by a second; the bind
// drawer opens on what core matched, never a guess between candidates; and the instance's App row
// says which installation no project uses and when GitHub keeps the App private.

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectionDirectoryItem } from "@forge/contracts/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveOrgProvider } from "@/features/orgs";
import { fakeCore, renderWithQuery } from "@/test/render";
import { IntegrationsScreen } from "./integrations-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/integrations" }));

const INSTANCE_APP = {
  id: "gh1",
  ownerType: "instance",
  ownerId: "00000000-0000-0000-0000-000000000000",
  provider: "github",
  displayName: "GitHub App forge-dev-env",
  config: { appSlug: "forge-dev-env", appOwner: "SidCorp-co", appOwnerIsOrg: true },
  active: true,
  lastHealthStatus: "ok",
  lastHealthDetail: null,
  lastHealthAt: null,
  breakerOpenedAt: null,
  directoryStatus: "connected",
  hasSecrets: true,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  usage: { bindings: [] },
} as unknown as ConnectionDirectoryItem;

const PROJECTS = [
  { id: "p1", slug: "forge", name: "Forge", orgId: "o1", archivedAt: null },
  { id: "p2", slug: "shop", name: "Shop", orgId: "o1", archivedAt: null },
  { id: "p3", slug: "notes", name: "Notes", orgId: "o1", archivedAt: null },
];

const target = (owner: string, repo: string, installationId = 9) => ({ provider: "github", installationId, owner, repo });

function world(extra: (call: { method: string; path: string; body?: unknown }) => { status?: number; body: unknown } | undefined = () => undefined) {
  return fakeCore((call) => {
    const hit = extra(call);
    if (hit) return hit;
    if (call.path === "/integration-connections") return { body: { items: [INSTANCE_APP] } };
    if (call.path === "/orgs") return { body: [{ id: "o1", name: "SidCorp", role: "owner", isPersonal: false }] };
    if (call.path === "/auth/me/preferences") return { body: { activeOrgId: "o1" } };
    if (call.path === "/integration-connections/gh1/github-app") {
      return {
        body: {
          connectionId: "gh1",
          instance: true,
          slug: "forge-dev-env",
          owner: "SidCorp-co",
          visibility: "public",
          makePublicUrl: null,
          completePath: null,
          installations: [],
        },
      };
    }
    if (call.path.startsWith("/projects")) return { body: PROJECTS };
    return undefined;
  });
}

const render = () =>
  renderWithQuery(
    <ActiveOrgProvider>
      <IntegrationsScreen />
    </ActiveOrgProvider>,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState(null, "", "/integrations");
});

describe("Connect GitHub is one button for the active org", () => {
  it("offers GitHub as a single button with no project to tick and no field to fill, and goes to the install page", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const calls = world((call) =>
      call.method === "POST" && call.path === "/integration-connections/github/connect"
        ? { body: { kind: "install", installUrl: "https://github.com/apps/forge-dev-env/installations/new?state=s" } }
        : undefined,
    );
    render();
    await userEvent.click(await screen.findByRole("button", { name: "Add connection" }));
    const flow = await screen.findByTestId("add-connection-flow");
    await userEvent.selectOptions(within(flow).getByRole("combobox", { name: "App" }), "github");

    const connect = await within(flow).findByRole("button", { name: "Connect GitHub" });
    expect(within(flow).queryAllByRole("checkbox")).toEqual([]);
    expect(within(flow).queryAllByRole("textbox")).toEqual([]);
    await userEvent.click(connect);

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("https://github.com/apps/forge-dev-env/installations/new?state=s"));
    expect(calls.filter((c) => c.method === "POST")).toEqual([
      { method: "POST", path: "/integration-connections/github/connect", body: { orgId: "o1", returnTo: "integrations" } },
    ]);
  });

  it("PLANT: an App awaiting completion is completed with its client secret, never a manifest for a second App", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    let completed = false;
    const calls = world((call) => {
      if (call.method === "POST" && call.path === "/integration-connections/github/connect") {
        return completed
          ? { body: { kind: "install", installUrl: "https://github.com/apps/forge-dev-env/installations/new?state=s" } }
          : {
              body: {
                kind: "complete",
                connectionId: "fea7dc5e",
                displayName: "GitHub App forge-dev-env",
                completePath: "/api/integration-connections/fea7dc5e/github-app/complete",
              },
            };
      }
      if (call.method === "POST" && call.path === "/integration-connections/fea7dc5e/github-app/complete") {
        completed = true;
        return { body: { recorded: [], notRecorded: [] } };
      }
      return undefined;
    });
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    render();
    await userEvent.click(await screen.findByRole("button", { name: "Add connection" }));
    const flow = await screen.findByTestId("add-connection-flow");
    await userEvent.selectOptions(within(flow).getByRole("combobox", { name: "App" }), "github");
    await userEvent.click(await within(flow).findByRole("button", { name: "Connect GitHub" }));

    const complete = await within(flow).findByTestId("github-complete-app");
    expect(complete.textContent).toContain("Complete this App first");
    expect(complete.textContent).toContain("GitHub App forge-dev-env");
    await userEvent.type(within(complete).getByLabelText(/Client secret/), "client-secret-of-the-app");
    await userEvent.click(within(complete).getByRole("button", { name: "Complete this App" }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(submit).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/integration-connections/github/connect",
      "/integration-connections/fea7dc5e/github-app/complete",
      "/integration-connections/github/connect",
    ]);
    submit.mockRestore();
  });
});

describe("the bind drawer opens on what core matched", () => {
  it("PLANT: ticks a matched project with its repository, names an ambiguous one's candidates unticked, and binds only the match", async () => {
    const calls = world((call) => {
      if (call.path === "/integration-connections/gh1/targets") {
        return {
          body: {
            targets: [target("SidCorp-co", "forge"), target("SidCorp-co", "shop"), target("chuongld", "shop", 4)],
            truncated: false,
            suggestedFor: [
              { projectId: "p1", by: "slug", target: target("SidCorp-co", "forge") },
              { projectId: "p2", by: "ambiguous", candidates: [target("SidCorp-co", "shop"), target("chuongld", "shop", 4)] },
              { projectId: "p-elsewhere", by: "slug", target: target("SidCorp-co", "shop") },
            ],
          },
        };
      }
      if (call.method === "POST" && call.path === "/integration-connections/gh1/bindings") return { body: { bindings: [] } };
      return undefined;
    });
    window.history.pushState(null, "", "/integrations?bind=gh1");
    render();
    const flow = await screen.findByTestId("bind-connection-flow");

    const forge = await within(flow).findByRole("checkbox", { name: "Forge" });
    expect(forge).toBeChecked();
    expect(within(flow).getByRole("combobox", { name: "Repository for Forge" })).toHaveValue("SidCorp-co/forge");
    expect(within(flow).getByRole("checkbox", { name: "Shop" })).not.toBeChecked();
    expect(flow.textContent).toContain("Several repositories match: SidCorp-co/shop, chuongld/shop.");
    expect(within(flow).getByRole("checkbox", { name: "Notes" })).not.toBeChecked();

    await userEvent.click(within(flow).getByRole("button", { name: "Bind (1)" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.filter((c) => c.method === "POST")).toEqual([
      {
        method: "POST",
        path: "/integration-connections/gh1/bindings",
        body: { bindings: [{ projectId: "p1", role: "service", target: target("SidCorp-co", "forge") }] },
      },
    ]);
  });
});

describe("the instance App's row", () => {
  it("stands in the org's directory as this Forge's, naming an unused installation and a private App", async () => {
    world((call) =>
      call.path === "/integration-connections/gh1/github-app"
        ? {
            body: {
              connectionId: "gh1",
              instance: true,
              slug: "forge-dev-env",
              owner: "SidCorp-co",
              visibility: "private",
              makePublicUrl: "https://github.com/organizations/SidCorp-co/settings/apps/forge-dev-env/advanced",
              completePath: null,
              installations: [
                {
                  installationId: 171606736,
                  account: "SidCorp-co",
                  accountType: "Organization",
                  state: "active",
                  used: false,
                  settingsUrl: "https://github.com/organizations/SidCorp-co/settings/installations/171606736",
                },
              ],
            },
          }
        : undefined,
    );
    render();
    expect(await screen.findByText("GitHub App forge-dev-env")).toBeTruthy();
    expect(screen.getByText("This Forge")).toBeTruthy();
    const detail = await screen.findByTestId("github-app-row-detail");
    expect(detail.textContent).toContain("Installed on SidCorp-co, not used by any project.");
    expect(detail.textContent).toContain("This App is private, so it installs only on SidCorp-co.");
    expect(within(detail).getByRole("link", { name: "Make it public on GitHub to install it on an organization" }).getAttribute("href")).toBe(
      "https://github.com/organizations/SidCorp-co/settings/apps/forge-dev-env/advanced",
    );
  });
});
