// An org's members read by name (ISS-1072 round 2): the org page drew each project agent by its minted
// address, `autoflow.27285ff18a5b@agents.forge.invalid`. An agent reads as its name with an Agent
// badge and its address never shows, on the row or in what its remove button says; a person reads
// by the name core sends.
// @direct-test-of packages/web-v2/src/features/orgs/types.ts

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Seeded } from "@/test/vi-chrome-requirements";
import type { OrgListItem, OrgMemberRow } from "../types";
import { MemberList } from "./org-member-sections";

vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const ORG: OrgListItem = { id: "o1", slug: "sidcorp", name: "SidCorp", isPersonal: false, role: "owner", createdAt: "2026-10-01T00:00:00.000Z" };
const AT = "2026-10-01T00:00:00.000Z";
const MEMBERS: OrgMemberRow[] = [
  { userId: "a1", name: "autoflow", agent: true, email: "autoflow.27285ff18a5b@agents.forge.invalid", role: "member", lenses: [], createdAt: AT },
  { userId: "u-me", name: "qa@forge-dev.sidcorp.co", agent: false, email: "qa@forge-dev.sidcorp.co", role: "member", lenses: [], createdAt: AT },
  { userId: "u2", name: "Lan Pham", agent: false, email: "lan@sidcorp.co", role: "owner", lenses: [], createdAt: AT },
];

describe("an org's members", () => {
  it("names an agent with an Agent badge and never its address; a person by name", async () => {
    mount();
    const agent = await screen.findByTestId("org-member-a1");
    expect(agent.textContent?.startsWith("autoflow")).toBe(true);
    expect(within(agent).getByText("Agent")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("agents.forge.invalid");
    expect(within(screen.getByTestId("org-member-u2")).getByText("Lan Pham")).toBeInTheDocument();
    expect(within(screen.getByTestId("org-member-u2")).queryByText("Agent")).toBeNull();
  });
});

function mount() {
  return render(
    <Seeded data={[[["orgs", "o1", "members"], MEMBERS]]}>
      <MemberList org={ORG} canManage roleOptions={[{ value: "member", label: "Member" }, { value: "owner", label: "Owner" }]} />
    </Seeded>,
  );
}
