// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgSwitcher } from "./components/org-switcher";
import type { OrgListItem } from "./types";
import { workspaceName } from "./workspace-name";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const personal: OrgListItem = {
  id: "o1", slug: "mai", name: "Mai Tran", isPersonal: true, role: "owner", createdAt: "2026-10-01T00:00:00.000Z",
};
vi.mock("./active-org", () => ({
  useActiveOrg: () => ({ orgs: [personal], activeOrg: personal, setActiveOrg: vi.fn(), isSingle: true }),
}));

afterEach(cleanup);

// ISS-1229 r22, judge-63: the switcher, org home and page headers called every personal workspace
// "Personal" while Settings → Organizations showed the name it follows ("Mai Tran").
describe("what a workspace is called where it is named", () => {
  it("is its stored name, a personal workspace's included", () => {
    expect(workspaceName({ name: "Mai Tran", isPersonal: true })).toBe("Mai Tran");
    expect(workspaceName({ name: "Personal", isPersonal: true })).toBe("Personal");
    expect(workspaceName({ name: "Sidcorp", isPersonal: false })).toBe("Sidcorp");
  });

  it('is "Personal" only for a personal workspace whose name is blank', () => {
    expect(workspaceName({ name: "  ", isPersonal: true })).toBe("Personal");
    expect(workspaceName({ name: " Mai Tran ", isPersonal: true })).toBe("Mai Tran");
  });

  it("is what the rail's switcher shows", () => {
    render(createElement(OrgSwitcher, { variant: "compact" }));
    expect(screen.getByRole("link", { name: "Organization: Mai Tran" })).toBeTruthy();
    expect(screen.queryByText("Personal")).toBeNull();
  });
});
