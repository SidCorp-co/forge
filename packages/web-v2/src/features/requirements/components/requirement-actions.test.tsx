// The one primary act a requirement offers where it stands. FB-73: "Agree r1" was pressable while
// every press would be refused REQUIREMENT_DESIGN_UNAPPROVED; core now names the unapproved linked
// designs in the standing, and the act is held, saying which, until they are approved.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { RequirementDetail } from "../types";
import { PrimaryActions, ProposalDecision } from "./requirement-actions";

function detail(unapprovedDesigns: { flow: string; title: string; designStatus: string | null }[]): RequirementDetail {
  return {
    key: "REQ-2",
    status: "draft",
    canSignOff: true,
    deferral: null,
    revisions: [{ revision: 1, state: "current" }],
    standing: {
      state: "draft",
      waitingOn: { kind: "you", who: "You", act: "agree r1", rule: "", ref: null, dueAt: null },
      facts: { stalePins: [], staleContractPins: [], unapprovedDesigns },
    },
  } as unknown as RequirementDetail;
}

const agree = () => screen.getByRole("button", { name: "Agree r1" });

describe("Agree on a draft requirement", () => {
  it("is held, naming each unapproved linked design, while any is listed", async () => {
    const calls = fakeCore(() => undefined);
    const user = userEvent.setup();
    renderWithQuery(
      <PrimaryActions projectId="p1" slug="epod" d={detail([{ flow: "checkout", title: "Checkout", designStatus: "proposed" }, { flow: "refund", title: "Refund", designStatus: null }])} />,
    );
    expect(agree()).toBeDisabled();
    await user.hover(agree().closest('[data-slot="tooltip-trigger"]') as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
        "not approved: Checkout (proposed), Refund (no design yet)",
      ),
    );
    await user.click(agree());
    expect(calls).toEqual([]);
  });

  it("agrees the head once every linked design is approved", async () => {
    const calls = fakeCore(() => ({ body: detail([]) }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail([])} />);
    expect(agree()).toBeEnabled();
    await user.click(agree());
    expect(calls).toEqual([]);
    await user.click(within(screen.getByTestId("accept-step")).getByRole("button", { name: "Agree r1" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/projects/p1/requirements/REQ-2/agree", body: { revision: 1 } }));
  });

  it("names a refusal by its code when core refuses the agree anyway", async () => {
    fakeCore(() => ({
      status: 422,
      body: {
        error: {
          code: "REQUIREMENT_REFUSED",
          message: "refused",
          refusals: [{ code: "REQUIREMENT_DESIGN_UNAPPROVED", path: "/workflows", detail: 'not approved: "checkout"' }],
        },
      },
    }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail([])} />);
    await user.click(agree());
    await user.click(within(screen.getByTestId("accept-step")).getByRole("button", { name: "Agree r1" }));
    expect(await screen.findByTestId("refusal")).toHaveTextContent("REQUIREMENT_DESIGN_UNAPPROVED");
  });
});

// ISS-281 / FB-16: every sign-off a signer takes here (accept a proposed revision, agree or re-pin the
// head, accept a delivery) applied at once and sent no reason, though the API keeps one on each
// act (ISS-84). Each now opens a confirm step that sends what the signer typed.
describe("a sign-off opens a confirm step that sends the signer's reason", () => {
  const step = () => screen.getByTestId("accept-step");
  const typeReason = (user: ReturnType<typeof userEvent.setup>, text: string) =>
    user.type(within(step()).getByRole("textbox", { name: "Why it is accepted, and on whose authority" }), text);

  it("agrees the head with the typed reason", async () => {
    const calls = fakeCore(() => ({ body: detail([]) }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail([])} />);
    await user.click(agree());
    await typeReason(user, "BA review 6 Oct");
    await user.click(within(step()).getByRole("button", { name: "Agree r1" }));
    await waitFor(() =>
      expect(calls).toEqual([{ method: "POST", path: "/projects/p1/requirements/REQ-2/agree", body: { revision: 1, reason: "BA review 6 Oct" } }]),
    );
  });

  it("accepts a proposed revision with the typed reason, and Cancel sends nothing", async () => {
    const calls = fakeCore(() => ({ body: detail([]) }));
    const user = userEvent.setup();
    renderWithQuery(<ProposalDecision projectId="p1" d={detail([])} revision={2} />);
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(step()).toHaveTextContent("r2 becomes the current revision.");
    await user.click(within(step()).getByRole("button", { name: "Cancel" }));
    expect(calls).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await typeReason(user, "Owner asked for it");
    await user.click(within(step()).getByRole("button", { name: "Accept r2" }));
    await waitFor(() =>
      expect(calls).toEqual([{ method: "POST", path: "/projects/p1/requirements/REQ-2/revisions/2/accept", body: { reason: "Owner asked for it" } }]),
    );
  });

  it("accepts a delivered requirement with the typed reason", async () => {
    const delivered = {
      ...detail([]),
      status: "agreed",
      standing: { state: "delivered", waitingOn: { kind: "you" }, facts: { stalePins: [], staleContractPins: [], unapprovedDesigns: [] } },
      issues: [],
    } as unknown as RequirementDetail;
    const calls = fakeCore(() => ({ body: delivered }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={delivered} />);
    await user.click(screen.getByRole("button", { name: "Accept r1" }));
    expect(calls).toEqual([]);
    await typeReason(user, "UAT passed");
    await user.click(within(step()).getByRole("button", { name: "Accept r1" }));
    await waitFor(() =>
      expect(calls).toEqual([{ method: "POST", path: "/projects/p1/requirements/REQ-2/accept", body: { revision: 1, reason: "UAT passed" } }]),
    );
  });

  it("updates to the approved design with the typed reason", async () => {
    const stale = {
      ...detail([]),
      status: "agreed",
      standing: {
        state: "agreed",
        waitingOn: { kind: "you" },
        facts: { stalePins: [{ flow: "checkout", title: "Checkout", approved: 3, pinned: 2 }], staleContractPins: [], unapprovedDesigns: [] },
      },
    } as unknown as RequirementDetail;
    const calls = fakeCore(() => ({ body: stale }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={stale} />);
    await user.click(screen.getByRole("button", { name: "Update to the approved design" }));
    expect(calls).toEqual([]);
    await typeReason(user, "checkout r3 approved");
    await user.click(within(step()).getByRole("button", { name: "Update to the approved design" }));
    await waitFor(() =>
      expect(calls).toEqual([{ method: "POST", path: "/projects/p1/requirements/REQ-2/repin", body: { revision: 1, reason: "checkout r3 approved" } }]),
    );
  });
});
