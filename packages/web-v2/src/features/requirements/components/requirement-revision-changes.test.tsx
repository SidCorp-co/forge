// REQ-34 r2 BC-7 and BC-26 on the Revisions view (ISS-453 criterion 4, routed to ISS-457): the open
// revision says which criteria it added, changed and removed, as core computed them, and a revision
// that names what the requirement is shows that change beside the rest of its diff, which is how an
// assumed kind is corrected by a later revision.
//
// @direct-test-of packages/web-v2/src/features/requirements/components/requirement-proof.tsx
// @direct-test-of packages/web-v2/src/features/requirements/components/requirement-detail.tsx

import { QueryClient } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, HANG, renderWithQuery } from "@/test/render";
import { reqDetail } from "@/test/vi-chrome-requirements";
import type { RequirementDetail } from "../types";
import { RequirementPage } from "./requirement-detail";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

afterEach(() => vi.unstubAllGlobals());

const PROJECT = "7f1c1d1e-0000-4000-8000-000000000002";

function revisions(detail: RequirementDetail) {
  fakeCore(() => HANG);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["requirement", PROJECT, "REQ-1"], detail);
  renderWithQuery(<RequirementPage projectId={PROJECT} slug="hop" reqKey="REQ-1" tab="revisions" onTab={() => {}} />, client);
}

describe("a revision's changes on the Revisions view", () => {
  it("names the criteria the open revision added, changed and removed, and none it left alone", () => {
    const [open, current] = reqDetail.revisions;
    revisions({
      ...reqDetail,
      revisions: [{ ...(open as RequirementDetail["revisions"][number]), criteriaChanges: { against: 1, added: ["BC-4"], changed: ["BC-2"], removed: [] } }, current as RequirementDetail["revisions"][number]],
    });
    const changes = within(screen.getByTestId("open-revision")).getByTestId("criteria-changes");
    expect(changes).toHaveTextContent("Added BC-4");
    expect(changes).toHaveTextContent("Changed BC-2");
    expect(changes).not.toHaveTextContent("Removed");
  });

  it("shows a change of what the requirement is in the open revision's diff", async () => {
    const [open, current] = reqDetail.revisions as RequirementDetail["revisions"];
    revisions({ ...reqDetail, revisions: [{ ...(open as RequirementDetail["revisions"][number]), kind: "rule" }, { ...(current as RequirementDetail["revisions"][number]), kind: null }] });
    await userEvent.setup().click(within(screen.getByTestId("open-revision-diff")).getByRole("button"));
    const kind = await screen.findByTestId("revision-diff-kind");
    expect(kind).toHaveTextContent("What this requirement is");
    expect(within(kind).getByText("Not named yet").tagName).toBe("DEL");
    expect(within(kind).getByText("Rule").tagName).toBe("INS");
  });
});
