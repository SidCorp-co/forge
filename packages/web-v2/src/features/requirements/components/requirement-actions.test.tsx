// The one primary act a requirement offers where it stands. FB-73: "Agree r1" was pressable while
// every press would be refused REQUIREMENT_DESIGN_UNAPPROVED; core now names the unapproved linked
// designs in the standing, and the act is held, saying which, until they are approved.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { RequirementDetail } from "../types";
import { PrimaryActions } from "./requirement-actions";

function detail(unapprovedDesigns: { flow: string; designStatus: string | null }[]): RequirementDetail {
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
      <PrimaryActions projectId="p1" slug="epod" d={detail([{ flow: "checkout", designStatus: "proposed" }, { flow: "refund", designStatus: null }])} />,
    );
    expect(agree()).toBeDisabled();
    await user.hover(agree().closest('[data-slot="tooltip-trigger"]') as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
        "not approved: checkout (proposed), refund (no design yet)",
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
    expect(await screen.findByTestId("refusal")).toHaveTextContent("REQUIREMENT_DESIGN_UNAPPROVED");
  });
});
