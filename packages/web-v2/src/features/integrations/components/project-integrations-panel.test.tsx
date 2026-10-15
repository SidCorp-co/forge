// The project Integrations tab reads core's status cards into one table: a row says connected only
// where core does, offers the act that fixes what is not, and never names two bindings alike.

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { StatusCard } from "../types";
import { ProjectIntegrations } from "./project-integrations-panel";
import { cardDetail, say } from "@/test/said";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/" }));

const caps = { capabilities: { hasDeliveryLog: false } };

const UNREACHED_REPOSITORY: StatusCard = {
  key: "repository",
  label: "Repository",
  status: "not_configured",
  ...cardDetail(say("integrations.detail.unreachedConnect", { provider: "GitHub" })),
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

describe("ProjectIntegrations", () => {
  it("shows a repository no source host binding reaches as not connected, naming the act", async () => {
    serve([UNREACHED_REPOSITORY, GITHUB_OPEN]);
    renderWithQuery(<ProjectIntegrations projectId="p1" />);
    const row = (await screen.findAllByText("Repository"))[0]?.closest("tr") as HTMLElement;
    expect(within(row).getAllByText("Not connected").length).toBeGreaterThan(0);
    expect(within(row).queryByText("Connected")).toBeNull();
    expect(within(row).getAllByText("Not connected to GitHub yet").length).toBeGreaterThan(0);
    const link = within(row).getByRole("link", { name: "Connect GitHub on its row below to reach github.com/SidCorp-co/forge" });
    expect(link.getAttribute("href")).toBe("#integration-github");
  });

  it("offers connecting GitHub in one place only: the GitHub row owns the act, the repository row links to it", async () => {
    serve([UNREACHED_REPOSITORY, GITHUB_OPEN]);
    renderWithQuery(<ProjectIntegrations projectId="p1" />);
    const repository = (await screen.findAllByText("Repository"))[0]?.closest("tr") as HTMLElement;
    expect(within(repository).queryAllByRole("button")).toEqual([]);
    const connects = screen.getAllByRole("button", { name: /^Connect (GitHub|repository on GitHub)/ });
    expect(connects).toHaveLength(1);
    const owner = connects[0]?.closest("tr") as HTMLElement;
    expect(owner.id).toBe("integration-github");
    expect(owner.querySelector("[data-tour=int-connect]")).not.toBeNull();
    await userEvent.click(within(repository).getByRole("link", { name: /^Connect GitHub on its row below/ }));
    expect(document.activeElement).toBe(connects[0]);
  });

  it("offers to connect the repository on a github.com project's GitHub row, and it opens the GitHub drawer", async () => {
    serve([UNREACHED_REPOSITORY, GITHUB_OPEN]);
    renderWithQuery(<ProjectIntegrations projectId="p1" />);
    const connect = await screen.findByRole("button", { name: "Connect repository on GitHub" });
    expect(connect.textContent).toBe("Connect repository");
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
    renderWithQuery(<ProjectIntegrations projectId="p1" />);
    const manage = await screen.findAllByRole("button", { name: /^Manage Coolify/ });
    const names = manage.map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Manage Coolify dev", "Manage Coolify app y8w4c4ks"]);
    expect(new Set(names).size).toBe(2);
  });

  it("lists no core-health row and leaves an absent sync blank rather than repeating a placeholder", async () => {
    serve([UNREACHED_REPOSITORY, GITHUB_OPEN]);
    renderWithQuery(<ProjectIntegrations projectId="p1" />);
    await screen.findAllByText("Repository");
    expect(screen.queryByText("no sync data")).toBeNull();
    expect(screen.queryByText("no GitHub integration configured")).toBeNull();
    const github = screen.getByRole("button", { name: "Connect repository on GitHub" });
    expect(github).toBeTruthy();
  });

  // Beside the settings rail at 1024px the table had about 550px but chose its columns by the screen
  // (`sm:`), so the five columns clipped the Connect act and crushed the target to a sliver. jsdom
  // applies no container query, so this holds the contract: the folded columns answer to the table's
  // own container and to no screen width.
  it("chooses its columns by the width the table is given, never by the screen's", async () => {
    serve([UNREACHED_REPOSITORY, GITHUB_OPEN]);
    renderWithQuery(<ProjectIntegrations projectId="p1" />);
    const box = await screen.findByTestId("integrations-table");
    expect(box).toHaveClass("@container/integrations");
    const folding = [...box.querySelectorAll<HTMLElement>("th, td, span")].filter((el) => /(^|\s)\S*:(hidden|table-cell)(\s|$)/.test(el.className));
    expect(folding.length, "no column folds at all").toBeGreaterThan(0);
    for (const el of folding) expect(el.className, "a column that folds by the screen's width").not.toMatch(/(^|\s)(sm|md|lg|xl):(hidden|table-cell)/);
  });
});

