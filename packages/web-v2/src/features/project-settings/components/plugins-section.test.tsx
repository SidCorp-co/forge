// REQ-26: a project's plugin settings say which of its pins a box it shares cannot honour — per
// marketplace, since a box holds one clone of each — and say a refused conflict read rather than
// showing it as no conflict.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore } from "@/test/render";
import { PluginSettings } from "./plugins-section";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const P = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function core(conflicts: { status?: number; body: unknown }) {
  return fakeCore((c) => {
    if (c.method === "GET" && c.path === `/projects/${P}`)
      return { body: { id: P, slug: "hop", name: "Hop", agentConfig: { plugins: [{ marketplace: "SidCorp-co/forge-plugin", name: "forge", pinnedRef: A }] } } };
    if (c.method === "GET" && c.path === `/projects/${P}/plugin-conflicts`) return conflicts;
    return undefined;
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PluginSettings projectId={P} canEdit={false} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("the plugin pin conflicts", () => {
  it("names the marketplace, the box, and each project's plugin at its pin", async () => {
    core({
      body: {
        conflicts: [
          {
            device: { id: "d1", name: "shared-box" },
            marketplace: "SidCorp-co/forge-plugin",
            pins: [
              { project: "hop", name: "forge", ref: A },
              { project: "ops", name: "forge-codemap", ref: B },
            ],
          },
        ],
      },
    });
    mount();
    const banner = await screen.findByTestId("plugin-pin-conflicts");
    expect(banner).toHaveTextContent("SidCorp-co/forge-plugin has conflicting pins on shared-box:");
    expect(banner).toHaveTextContent("hop forge@aaaaaaa · ops forge-codemap@bbbbbbb");
    expect(banner).toHaveTextContent("The box follows latest");
  });

  it("shows nothing where no box conflicts", async () => {
    const calls = core({ body: { conflicts: [] } });
    const view = mount();
    await waitFor(() => expect(calls.some((c) => c.path === `/projects/${P}/plugin-conflicts`)).toBe(true));
    await waitFor(() => expect(view.container.querySelector("[data-testid=plugins-none], ul")).not.toBeNull());
    expect(screen.queryByTestId("plugin-pin-conflicts")).toBeNull();
  });

  it("says a refused read by its reason, never as no conflict", async () => {
    core({
      status: 422,
      body: {
        code: "PLUGIN_DESIGNATIONS_INVALID",
        message: "project ops stores agentConfig.plugins that no write door accepts",
        error: { code: "PLUGIN_DESIGNATIONS_INVALID", message: "project ops stores agentConfig.plugins that no write door accepts" },
      },
    });
    mount();
    expect(await screen.findByText(/project ops stores agentConfig\.plugins that no write door accepts/)).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-pin-conflicts")).toBeNull();
  });
});
