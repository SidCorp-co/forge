// A field the reader cannot change says why beside it: an agent's live run holds it, or the reader
// holds no write on the project. A greyed control with no reason is the defect this guards.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { productCopy } from "@/lib/i18n/product-copy";
import { agentHoldsEdit } from "../edit-lock";

const AGENT_HOLDS_EDIT = agentHoldsEdit(productCopy("en"));
import type { IssueDetail } from "../types";
import { IssueQuickActions } from "./issue-quick-actions";
import { PropertiesRail } from "./properties-rail";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const READ_ONLY = "You can read this project but not change it: a project admin can give you write access";

function issue(over: Partial<IssueDetail>): IssueDetail {
  return {
    id: "i-52",
    projectId: "p1",
    displayId: "ISS-52",
    title: "Snooze by the item's owner",
    status: "awaiting_release",
    priority: "medium",
    complexity: "s",
    agentStatus: "completed",
    labels: [],
    ...over,
  } as IssueDetail;
}

function rail(detail: IssueDetail, readOnly = false, onPatch: (body: object) => void = () => {}) {
  fakeCore(() => ({ body: {} }));
  renderWithQuery(
    <PropertiesRail
      issue={detail}
      slug="hop"
      cost={undefined}
      deps={undefined}
      pending={false}
      readOnly={readOnly}
      onPatch={onPatch}
      onTransition={() => {}}
      moves={[]}
    />,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("the issue's editable fields name the refusal that disables them", () => {
  it("says an agent's live run holds Priority and Complexity, on the controls themselves", () => {
    rail(issue({ status: "in_progress", agentStatus: "running" }));
    for (const name of ["Priority", "Complexity"]) {
      const control = screen.getByRole("combobox", { name });
      expect(control).toBeDisabled();
      expect(control).toHaveAccessibleDescription(AGENT_HOLDS_EDIT);
    }
    expect(screen.getByRole("status")).toHaveTextContent(AGENT_HOLDS_EDIT);
  });

  it("says a reader without write on the project cannot change them, rather than greying them silently", () => {
    rail(issue({}), true);
    const control = screen.getByRole("combobox", { name: "Priority" });
    expect(control).toBeDisabled();
    expect(control).toHaveAccessibleDescription(READ_ONLY);
    expect(screen.getByRole("status")).toHaveTextContent(READ_ONLY);
  });

  it("leaves the fields of a writable issue no run holds enabled, with nothing to explain", () => {
    rail(issue({}));
    const control = screen.getByRole("combobox", { name: "Priority" });
    expect(control).toBeEnabled();
    expect(control).not.toHaveAccessibleDescription();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("holds the peek's Priority under the same rule, naming it", () => {
    fakeCore(() => ({ body: {} }));
    renderWithQuery(
      <IssueQuickActions issueId="i-52" status="in_progress" moves={[]} agentStatus="running" priority="medium" />,
    );
    const control = screen.getByRole("combobox", { name: "Priority" });
    expect(control).toBeDisabled();
    expect(control).toHaveAccessibleDescription(AGENT_HOLDS_EDIT);
  });
});

// HOP (dev, 2026-10-07): an issue filed with no category, or the wrong one, could only be put right
// through the API. The rail sets and changes it beside Priority and Complexity, through the same PATCH.
describe("the issue's category on the rail", () => {
  it("is set on an issue that has none, and sent as the PATCH's category", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    rail(issue({ category: null }), false, onPatch);
    const control = screen.getByRole("combobox", { name: "Category" });
    expect(control).toHaveTextContent("Not set");
    await user.click(control);
    await user.click(await screen.findByRole("option", { name: "Bug" }));
    expect(onPatch).toHaveBeenCalledWith({ category: "bug" });
  });

  it("is cleared to null when Not set is chosen", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    rail(issue({ category: "feature" }), false, onPatch);
    const control = screen.getByRole("combobox", { name: "Category" });
    expect(control).toHaveTextContent("Feature");
    await user.click(control);
    await user.click(await screen.findByRole("option", { name: "Not set" }));
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ category: null }));
  });

  it("keeps a category outside the usual words as the chosen option", () => {
    rail(issue({ category: "hop-theme" }));
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveTextContent("Hop theme");
  });

  it("is held under the same refusal as Priority", () => {
    rail(issue({ status: "in_progress", agentStatus: "running", category: "bug" }));
    const control = screen.getByRole("combobox", { name: "Category" });
    expect(control).toBeDisabled();
    expect(control).toHaveAccessibleDescription(AGENT_HOLDS_EDIT);
  });
});

describe("an artifact carried between issues is said on both issues, flat", () => {
  it("names the carrier on the issue that touched it, and what the carrier carries on the carrier", () => {
    rail(
      issue({
        carriage: {
          carriedBy: [{ ref: "workflow 193 @999dcf6d: access block", issue: "ISS-110" }],
          carries: [{ ref: "workflow 96 @d00d9028: stamp block", from: "ISS-41" }],
        },
      }),
    );
    const by = screen.getByTestId("issue-carried-by");
    expect(by).toHaveTextContent("ISS-110");
    expect(by).toHaveTextContent("workflow 193 @999dcf6d: access block");
    expect(screen.getByText("Carried by")).toBeInTheDocument();
    expect(screen.getByTestId("issue-carries")).toHaveTextContent("from ISS-41");
    expect(screen.getByRole("link", { name: "ISS-110" }).getAttribute("href")).toContain("ISS-110");
    expect(productCopy("vi")("issues.rail.carriedBy")).toBe("Phát hành cùng"); // i18n-allow: asserts the vi carriage copy
  });
});
