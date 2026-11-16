// The Agents screen holds Runs and Sessions. Its Capabilities tab became the module map's
// Capabilities branch (ISS-1256), so a link kept from the tab lands there, one page and never two.
//
// @direct-test-of packages/web-v2/src/features/agents/components/agents-screen.tsx

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentsScreen } from "./agents-screen";

const replace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ replace }) }));

describe("the old Agents Capabilities tab", () => {
  it("lands on the map's Capabilities branch, drawing no Agents tab", () => {
    window.history.replaceState(null, "", "/projects/hop/agents?tab=capabilities");
    render(<AgentsScreen access={{ projectId: "p1", slug: "hop", canWrite: true }} />);
    expect(replace).toHaveBeenCalledWith("/projects/hop/modules?view=capabilities");
    expect(screen.queryByTestId("agents-tabs")).toBeNull();
  });
});
