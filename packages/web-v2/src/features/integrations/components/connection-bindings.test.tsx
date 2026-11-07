// A connection's drawer names each project it is bound on as core names it (ISS-1072), as the
// directory does: a project the reader's own list does not hold is never drawn by its id.
// @direct-test-of packages/web-v2/src/features/integrations/components/connection-detail-drawer.tsx

import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ConnectionBindings } from "./connection-detail-drawer";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const UNLISTED = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const binding = (id: string, projectId: string, projectName: string) => ({
  id,
  connectionId: "c1",
  projectId,
  projectName,
  provider: "coolify",
  role: "deploy",
  config: {},
  bindingConfig: {},
  label: "",
  active: true,
  bindingActive: true,
  connectionActive: true,
});

afterEach(() => vi.unstubAllGlobals());

describe("a connection's bindings in its drawer", () => {
  it("names each project by the name core sends, never its id", async () => {
    fakeCore((c) => {
      if (c.path === "/integration-connections/c1/bindings") return { body: { items: [binding("b1", "p1", "Hop"), binding("b2", UNLISTED, "Hospital Ops")] } };
      if (c.path === "/integration-connections") return { body: { items: [] } };
      if (c.path.startsWith("/projects")) return { body: [{ id: "p1", slug: "hop", name: "Hop" }] };
      return undefined;
    });
    renderWithQuery(<ConnectionBindings connectionId="c1" currentProjectId="p1" />);
    expect(await screen.findByText("Hospital Ops")).toBeTruthy();
    expect(screen.getByText("Hop")).toBeTruthy();
    expect(document.body.textContent).not.toContain(UNLISTED);
  });
});
