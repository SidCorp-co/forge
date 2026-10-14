// REQ-35 BC-7 and the decision on question 20c74d56 (2026-10-14, (a)): a proposal awaiting this
// reader opens with its diff showing, so nobody accepts a change they have not seen; every other
// revision stays folded until opened. "This reader" is whoever the page lets decide the proposal:
// the Accept and Reject beside it are theirs (`canSignOff`).
//
// @direct-test-of packages/web-v2/src/features/requirements/components/requirement-detail.tsx

import { QueryClient } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, HANG, renderWithQuery } from "@/test/render";
import { reqDetail } from "@/test/vi-chrome-requirements";
import type { RequirementDetail } from "../types";
import { PrimaryActions } from "./requirement-actions";
import { RequirementPage } from "./requirement-detail";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

afterEach(() => vi.unstubAllGlobals());

const PROJECT = "7f1c1d1e-0000-4000-8000-000000000002";
type Revision = RequirementDetail["revisions"][number];
type RequirementTab = Parameters<typeof RequirementPage>[0]["tab"];
const [proposedR2, currentR1] = reqDetail.revisions as [Revision, Revision];

function seeded(detail: RequirementDetail): QueryClient {
  fakeCore(() => HANG);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["requirement", PROJECT, "REQ-1"], detail);
  return client;
}

function onRevisions(detail: RequirementDetail): void {
  renderWithQuery(<RequirementPage projectId={PROJECT} slug="hop" reqKey="REQ-1" tab="revisions" onTab={() => {}} />, seeded(detail));
}

/** The diff under the open revision, drawn only while its fold is open. */
const diffShown = () => within(screen.getByTestId("open-revision-diff")).queryByTestId("revision-diff");

/** The requirement screen's act and page, as `requirement-screen.tsx` wires them: Review proposal turns to Revisions. */
function Screen({ detail }: { detail: RequirementDetail }) {
  const [tab, setTab] = useState<RequirementTab>("overview");
  return (
    <>
      <PrimaryActions projectId={PROJECT} slug="hop" d={detail} onReview={() => setTab("revisions")} />
      <RequirementPage projectId={PROJECT} slug="hop" reqKey="REQ-1" tab={tab} onTab={setTab} />
    </>
  );
}

describe("a proposal awaiting this reader opens on its diff", () => {
  it("opens the diff of a proposal the reader decides, with nothing pressed", () => {
    onRevisions({ ...reqDetail, canSignOff: true, revisions: [proposedR2, currentR1] });
    expect(within(screen.getByTestId("open-revision")).getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(diffShown(), "a proposal awaiting this reader is folded").not.toBeNull();
  });

  it("keeps the diff folded for a reader who cannot decide the proposal", () => {
    onRevisions({ ...reqDetail, canSignOff: false, revisions: [proposedR2, currentR1] });
    expect(within(screen.getByTestId("open-revision")).queryByRole("button", { name: "Accept" })).toBeNull();
    expect(diffShown(), "a proposal awaiting someone else is open").toBeNull();
  });

  it("keeps a draft's diff folded, whoever reads it", () => {
    onRevisions({ ...reqDetail, canSignOff: true, revisions: [{ ...proposedR2, state: "draft" }, currentR1] });
    expect(diffShown(), "a revision not awaiting a decision is open").toBeNull();
  });

  it("lands Review proposal on the proposal with its diff showing", async () => {
    renderWithQuery(<Screen detail={{ ...reqDetail, canSignOff: true, revisions: [proposedR2, currentR1] }} />, seeded({ ...reqDetail, canSignOff: true, revisions: [proposedR2, currentR1] }));
    expect(screen.queryByTestId("open-revision")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Review proposal r2" }));
    expect(await screen.findByTestId("open-revision")).toBeInTheDocument();
    expect(diffShown(), "Review proposal landed on a folded diff").not.toBeNull();
  });
});
