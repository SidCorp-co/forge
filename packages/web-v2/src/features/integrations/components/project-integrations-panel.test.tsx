// The project Integrations tab reads core's status cards into one table: a row says connected only
// where core does, offers the act that fixes what is not, and never names two bindings alike.

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { StatusCard } from "../types";
import { ProjectIntegrationsPanel } from "./project-integrations-panel";
import { cardDetail, say } from "@/test/said";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/" }));

const caps = { capabilities: { hasDeliveryLog: false } };

const UNREACHED_REPOSITORY: StatusCard = {
  key: "repository",
  label: "Repository",
  status: "not_configured",
  ...cardDetail(say("integrations.detail.unreachedConnect", { host: "github.com", provider: "GitHub" })),
  lastSyncAt: null,
  configured: true,
  meta: {
    repository: "github.com/SidCorp-co/forge",
    remoteUrl: "https://github.com/SidCorp-co/forge",
    host: "github.com",
    provider: null,
    connectProvider: "github",
  },
};

const GITHUB_OPEN: StatusCard = {
  key: "github",
  label: "GitHub",
  status: "not_configured",
  ...cardDetail(say("integrations.detail.noneConfigured", { provider: "GitHub" })),
  lastSyncAt: null,
  configured: false,
  meta: caps,
};

function coolify(key: string, bindingId: string, name: string, environment: string | null): StatusCard {
  return {
    key,
    label: `Coolify (${name})`,
    status: "connected",
    ...cardDetail(say("integrations.detail.lastHealth", { status: "ok" })),
    lastSyncAt: null,
    configured: true,
    meta: { ...caps, bindingId, role: "deploy", environment, name, lastHealthStatus: "ok" },
  };
}

function serve(cards: StatusCard[]) {
  return fakeCore((call) => {
    if (call.path === "/projects/p1/integrations/status") return { body: { cards } };
    if (call.path === "/projects/p1/integrations") return { body: { items: [] } };
    if (call.path === "/projects/p1/integrations/mcp-preview") return { body: { servers: [] } };
    if (call.path.startsWith("/integration-connections")) return { body: { items: [] } };
    if (call.path.startsWith("/projects")) return { body: [] };
    return undefined;
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("ProjectIntegrationsPanel", () => {
  it("shows a repository no source host binding reaches as not connected, naming the cost and the act", async () => {
    serve([UNREACHED_REPOSITORY, GITHUB_OPEN]);
    renderWithQuery(<ProjectIntegrationsPanel projectId="p1" />);
    const row = (await screen.findAllByText("Repository"))[0]?.closest("tr") as HTMLElement;
    expect(within(row).getAllByText("Not connected").length).toBeGreaterThan(0);
    expect(within(row).queryByText("Connected")).toBeNull();
    expect(within(row).getAllByText(/cannot tell what already shipped/).length).toBeGreaterThan(0);
    const link = within(row).getByRole("link", { name: "Connect GitHub on its row below to reach github.com/SidCorp-co/forge" });
    expect(link.getAttribute("href")).toBe("#integration-github");
  });

  it("offers connecting GitHub in one place only: the GitHub row owns the act, the repository row links to it", async () => {
    serve([UNREACHED_REPOSITORY, GITHUB_OPEN]);
    renderWithQuery(<ProjectIntegrationsPanel projectId="p1" />);
    const repository = (await screen.findAllByText("Repository"))[0]?.closest("tr") as HTMLElement;
    expect(within(repository).queryAllByRole("button")).toEqual([]);
    const connects = screen.getAllByRole("button", { name: /^Connect GitHub/ });
    expect(connects).toHaveLength(1);
    const owner = connects[0]?.closest("tr") as HTMLElement;
    expect(owner.id).toBe("integration-github");
    expect(owner.querySelector("[data-tour=int-connect]")).not.toBeNull();
    await userEvent.click(within(repository).getByRole("link", { name: /^Connect GitHub on its row below/ }));
    expect(document.activeElement).toBe(connects[0]);
  });

  it("offers the GitHub connect act on a github.com project, and it opens the GitHub drawer", async () => {
    serve([UNREACHED_REPOSITORY, GITHUB_OPEN]);
    renderWithQuery(<ProjectIntegrationsPanel projectId="p1" />);
    const connect = await screen.findByRole("button", { name: "Connect GitHub" });
    expect(connect.closest("tr")?.textContent).toContain("GitHub");
    await userEvent.click(connect);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getAllByText("GitHub").length).toBeGreaterThan(0);
  });

  it("names two bindings of one provider apart and never repeats a row's text", async () => {
    serve([
      coolify("coolify:dev", "b-dev", "dev", "dev"),
      coolify("coolify:deploy", "b-other", "app y8w4c4ks", null),
    ]);
    renderWithQuery(<ProjectIntegrationsPanel projectId="p1" />);
    const manage = await screen.findAllByRole("button", { name: /^Manage Coolify/ });
    const names = manage.map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Manage Coolify dev", "Manage Coolify app y8w4c4ks"]);
    expect(new Set(names).size).toBe(2);
  });

  it("lists no core-health row and leaves an absent sync blank rather than repeating a placeholder", async () => {
    serve([UNREACHED_REPOSITORY, GITHUB_OPEN]);
    renderWithQuery(<ProjectIntegrationsPanel projectId="p1" />);
    await screen.findAllByText("Repository");
    expect(screen.queryByText("no sync data")).toBeNull();
    expect(screen.queryByText("no GitHub integration configured")).toBeNull();
    const github = screen.getByRole("button", { name: "Connect GitHub" });
    expect(github).toBeTruthy();
  });
});
