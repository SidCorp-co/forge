// A project's members read by name, as the org's do (ISS-1072 round 3): Project settings › People drew
// `forge.5882f10d89d3@agents.forge.invalid` and `steward.65f7ff153027@…` with no Agent badge after
// round 2 fixed only the org page. An agent reads as its name with an Agent badge, its address never
// shown on the row, in its role select or in what its remove button says.
// @direct-test-of packages/web-v2/src/features/project-settings/components/members-tab.tsx

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Seeded } from "@/test/vi-chrome-requirements";
import type { ProjectMemberRow } from "../types";
import { MembersTab } from "./members-tab";

vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const P = "p1";
const AT = "2026-10-01T00:00:00.000Z";
const MEMBERS: ProjectMemberRow[] = [
  { userId: "a1", name: "forge", agent: true, email: "forge.5882f10d89d3@agents.forge.invalid", role: "admin", createdAt: AT },
  { userId: "a2", name: "steward", agent: true, email: "steward.65f7ff153027@agents.forge.invalid", role: "viewer", createdAt: AT },
  { userId: "u2", name: "Lan Pham", agent: false, email: "lan@sidcorp.co", displayName: "Lan Pham", role: "member", createdAt: AT },
];

function mount(canEdit: boolean) {
  return render(
    <Seeded
      data={[
        [["project", P, "members"], MEMBERS],
        [["project", P, "invitations"], []],
        [["projects", "all"], []],
      ]}
    >
      <MembersTab projectId={P} canEdit={canEdit} />
    </Seeded>,
  );
}

describe("a project's members", () => {
  it("names each agent with an Agent badge and never its minted address; a person by name", async () => {
    mount(false);
    for (const [id, name] of [
      ["a1", "forge"],
      ["a2", "steward"],
    ]) {
      const row = await screen.findByTestId(`project-member-${id}`);
      expect(row.textContent?.startsWith(name)).toBe(true);
      expect(within(row).getByText("Agent")).toBeInTheDocument();
    }
    const person = screen.getByTestId("project-member-u2");
    expect(within(person).getByText("Lan Pham")).toBeInTheDocument();
    expect(within(person).queryByText("Agent")).toBeNull();
    expect(document.body.innerHTML).not.toContain("agents.forge.invalid");
  });

  it("names an agent by its name in the controls an admin reads too", async () => {
    mount(true);
    await screen.findByTestId("project-member-a1");
    expect(screen.getByRole("button", { name: "Remove forge" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("agents.forge.invalid");
  });
});
