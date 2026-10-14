// The workspace Integrations screen: named as the nav names it, with the act that adds a connection
// and binds its projects without leaving the page (FB-128), every app standing open with its health
// in view, each row naming its bindings apart, and GitHub's return landing here in words.

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectionDirectoryItem } from "@forge/contracts/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { IntegrationsScreen } from "./integrations-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/integrations" }));

const COOLIFY: ConnectionDirectoryItem = {
  id: "c1",
  ownerType: "org",
  ownerId: "o1",
  provider: "coolify",
  displayName: "Coolify (manage.example.com)",
  config: { baseUrl: "https://manage.example.com" },
  active: true,
  lastHealthStatus: "ok",
  lastHealthDetail: null,
  lastHealthAt: null,
  breakerOpenedAt: null,
  directoryStatus: "connected",
  hasSecrets: true,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  usage: {
    bindings: [
      { id: "b1", projectId: "p1", role: "deploy", label: "", name: "dev", active: true },
      { id: "b2", projectId: "p1", role: "deploy", label: "", name: "app y8w4c4ks", active: true },
    ],
  },
} as ConnectionDirectoryItem;

const GITLAB: ConnectionDirectoryItem = {
  ...COOLIFY,
  id: "c2",
  provider: "gitlab",
  displayName: "GitLab fork",
  config: { baseUrl: "https://gitlab.com", projectPath: "it/autoflow" },
  usage: { bindings: [{ id: "b3", projectId: "p1", role: "source", label: "", name: "Source", active: true }] },
} as ConnectionDirectoryItem;

function serve() {
  return fakeCore((call) => {
    if (call.path === "/integration-connections") return { body: { items: [COOLIFY, GITLAB] } };
    if (call.path === "/orgs") return { body: [{ id: "o1", name: "SidCorp", role: "owner" }] };
    if (call.path.startsWith("/projects")) {
      return { body: [{ id: "p1", slug: "forge", name: "Forge", orgId: "o1", archivedAt: null }] };
    }
    return undefined;
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("IntegrationsScreen", () => {
  it("is titled as the nav names it, and adds a connection here rather than sending the person into a project", async () => {
    serve();
    renderWithQuery(<IntegrationsScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Integrations");
    await userEvent.click(screen.getByRole("button", { name: "Add connection" }));
    const flow = await screen.findByTestId("add-connection-flow");
    expect(within(flow).getByRole("checkbox", { name: "Forge" })).toBeTruthy();
    expect(within(flow).getByRole("combobox", { name: "App" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Forge" })).toBeNull();
  });

  it("names why GitHub's return could not finish, and the App it left on GitHub, from the query core lands it with", async () => {
    serve();
    window.history.pushState(null, "", "/integrations?github=state_expired&app=forge-test-app&appOwner=SidCorp-co&appOrg=1");
    renderWithQuery(<IntegrationsScreen />);
    const banner = await screen.findByTestId("github-stranded");
    expect(banner.textContent).toContain("more than an hour old");
    expect(banner.textContent).toContain("forge-test-app");
    expect(within(banner).getByRole("link").getAttribute("href")).toBe(
      "https://github.com/organizations/SidCorp-co/settings/apps/forge-test-app",
    );
    window.history.pushState(null, "", "/integrations");
  });

  it("points at GitHub's list of Apps when the return could not be shown to be the person's own", async () => {
    serve();
    window.history.pushState(null, "", "/integrations?github=state_invalid");
    renderWithQuery(<IntegrationsScreen />);
    const banner = await screen.findByTestId("github-stranded");
    expect(banner.textContent).toContain("Forge did not start");
    expect(within(banner).getByRole("link").getAttribute("href")).toBe("https://github.com/settings/apps");
    window.history.pushState(null, "", "/integrations");
  });

  it("binds a GitHub App back from its install into each ticked project's repository, in one call", async () => {
    const calls = fakeCore((call) => {
      if (call.path === "/integration-connections/c3/targets") {
        return { body: { targets: [{ provider: "github", installationId: 9, owner: "SidCorp-co", repo: "forge" }], truncated: false } };
      }
      if (call.method === "POST" && call.path === "/integration-connections/c3/bindings") return { body: { bindings: [] } };
      if (call.path === "/integration-connections") return { body: { items: [COOLIFY, GITLAB] } };
      if (call.path === "/orgs") return { body: [{ id: "o1", name: "SidCorp", role: "owner" }] };
      if (call.path.startsWith("/projects")) {
        return { body: [{ id: "p1", slug: "forge", name: "Forge", orgId: "o1", archivedAt: null }] };
      }
      return undefined;
    });
    window.history.pushState(null, "", "/integrations?bind=c3");
    renderWithQuery(<IntegrationsScreen />);
    const flow = await screen.findByTestId("bind-connection-flow");
    await userEvent.click(await within(flow).findByRole("checkbox", { name: "Forge" }));
    await userEvent.selectOptions(within(flow).getByRole("combobox", { name: "Repository for Forge" }), "SidCorp-co/forge");
    await userEvent.click(within(flow).getByRole("button", { name: "Bind (1)" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/integration-connections/c3/bindings",
        body: {
          bindings: [
            { projectId: "p1", role: "service", target: { provider: "github", installationId: 9, owner: "SidCorp-co", repo: "forge" } },
          ],
        },
      },
    ]);
    window.history.pushState(null, "", "/integrations");
  });

  it("stands every app open, so a lone connection's health and status are in view without a click", async () => {
    serve();
    renderWithQuery(<IntegrationsScreen />);
    expect(await screen.findByText("GitLab fork")).toBeTruthy();
    expect(screen.getByText("Coolify (manage.example.com)")).toBeTruthy();
    expect(screen.getAllByText("Connected").length).toBe(2);
    expect(screen.getByText("2 connections")).toBeTruthy();
  });

  it("names a connection's two bindings on one project apart, and never twice the same", async () => {
    serve();
    renderWithQuery(<IntegrationsScreen />);
    const button = await screen.findByRole("button", { name: /^Manage connection Coolify/ });
    const label = button.getAttribute("aria-label") ?? "";
    expect(label).toContain("Forge dev");
    expect(label).toContain("Forge app y8w4c4ks");
  });
});
