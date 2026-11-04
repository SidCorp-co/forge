// The issue rail's Requirement property names the requirement an issue delivers and links to it. The
// HOP master's 2026-10-08 ask had given it a picker and an Unlink; since ISS-687 linking an issue is
// the agents' act (REQ-68 BC-6) and core refuses it from the web by name, so the rail offers neither
// and writes nothing.

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { IssueRequirementProperty } from "./requirement-property";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

describe("the issue rail's Requirement property", () => {
  it("names the requirement by its title, its key on hover, and offers no Unlink", () => {
    const calls = fakeCore(() => undefined);
    renderWithQuery(<IssueRequirementProperty slug="hop" current="REQ-5" currentTitle="Referrals" />);
    const link = screen.getByRole("link", { name: "Referrals" });
    expect(link).toHaveAttribute("href", "/projects/hop/requirements/REQ-5");
    expect(link).toHaveAttribute("title", "REQ-5");
    expect(screen.queryByRole("button")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("names a sibling project's requirement with its project and links there", () => {
    renderWithQuery(
      <IssueRequirementProperty slug="adminhub-fe" current="REQ-14" requirementProject={{ id: "api", slug: "adminhub-api", name: "adminhub-api" }} />,
    );
    expect(screen.getByRole("link", { name: "adminhub-api/REQ-14" })).toHaveAttribute("href", "/projects/adminhub-api/requirements/REQ-14");
  });

  it("an issue delivering none says so, with no picker and no read of the requirements", () => {
    const calls = fakeCore(() => undefined);
    renderWithQuery(<IssueRequirementProperty slug="hop" current={null} />);
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(calls).toEqual([]);
  });
});
