// The workspace Integrations screen: named as the nav names it, with the act that adds a connection,
// every app standing open with its health in view, and each row naming its bindings apart.

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectionDirectoryItem } from "@forge/contracts/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { IntegrationsScreen } from "./integrations-screen";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/integrations" }));

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
  it("is titled as the nav names it and carries the act that adds a connection", async () => {
    serve();
    renderWithQuery(<IntegrationsScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Integrations");
    await userEvent.click(screen.getByRole("button", { name: "Add connection" }));
    const link = await screen.findByRole("link", { name: "Forge" });
    expect(link.getAttribute("href")).toBe("/projects/forge/settings?tab=connections#integrations");
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
