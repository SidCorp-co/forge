// The one primary act a requirement offers where it stands. FB-73: "Agree r1" was pressable while
// every press would be refused REQUIREMENT_DESIGN_UNAPPROVED; core now names the unapproved linked
// designs in the standing, and the act is held, saying which, until they are approved.

import { RULE, say, waitingOn } from "@/test/said";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { productCopy } from "@/lib/i18n/product-copy";
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
      waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.agreeR", { r: 1 }), rule: RULE }),
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
        waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.updateToDesign", { design: "Checkout", r: 3 }), rule: RULE }),
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

// The acts that only open on a press (drop, defer, the held agree's reason) read in the chosen
// language too; the walking test sees the closed state only.
describe("a requirement's acts in Vietnamese", () => {
  const vi = productCopy("vi");
  const inVi = (ui: ReactElement) => renderWithQuery(<InterfaceLanguageScope language="vi">{ui}</InterfaceLanguageScope>);

  it("names the held agree and each unapproved design by its label", async () => {
    fakeCore(() => undefined);
    const user = userEvent.setup();
    inVi(<PrimaryActions projectId="p1" slug="epod" d={detail([{ flow: "checkout", title: "Checkout", designStatus: "proposed" }, { flow: "refund", title: "Refund", designStatus: null }])} />);
    const held = screen.getByRole("button", { name: vi("requirements.act.agreeR", { r: 1 }) });
    expect(held).toBeDisabled();
    await user.hover(held.closest('[data-slot="tooltip-trigger"]') as HTMLElement);
    const designs = `Checkout (${productCopy("vi")("label.designStatus.proposed").toLowerCase()}), Refund (${vi("requirements.act.noDesignYet")})`;
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(vi("requirements.act.agreeHeldTip", { designs })));
  });

  it("opens drop and defer with their reasons asked in Vietnamese", async () => {
    fakeCore(() => undefined);
    const user = userEvent.setup();
    inVi(<PrimaryActions projectId="p1" slug="epod" d={detail([])} />);
    await user.click(screen.getByRole("button", { name: vi("requirements.act.drop") }));
    expect(screen.getByRole("textbox", { name: vi("requirements.act.dropWhyLabel") })).toHaveAttribute("placeholder", vi("requirements.act.dropWhy"));
    await user.click(screen.getByRole("button", { name: vi("common.cancel") }));
    await user.click(screen.getByRole("button", { name: vi("requirements.act.defer") }));
    expect(screen.getByRole("textbox", { name: vi("requirements.act.deferWhyLabel") })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: vi("requirements.act.meantForLabel") })).toHaveAttribute("placeholder", vi("requirements.act.meantFor"));
  });

  it("asks the signer's reason in Vietnamese and says what accepting does", async () => {
    fakeCore(() => undefined);
    const user = userEvent.setup();
    inVi(<ProposalDecision projectId="p1" d={detail([])} revision={2} />);
    await user.click(screen.getByRole("button", { name: vi("requirements.act.accept") }));
    const step = screen.getByTestId("accept-step");
    expect(step).toHaveTextContent(vi("requirements.act.acceptConsequence", { r: 2 }));
    expect(within(step).getByRole("textbox", { name: vi("common.acceptWhyLabel") })).toBeInTheDocument();
    expect(within(step).getByRole("button", { name: vi("requirements.act.acceptR", { r: 2 }) })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: vi("requirements.act.reject") }));
    expect(screen.getByRole("button", { name: vi("requirements.act.returnR", { r: 2 }) })).toBeInTheDocument();
  });
});

// An undefer is a person's act with a reason, as the defer it undoes is: the Undefer button asked
// none and recorded none, while Defer did.
describe("Undefer on a deferred requirement", () => {
  const deferred = () =>
    ({
      ...detail([]),
      status: "deferred",
      deferral: { from: "agreed", reason: "out of v1", targetPhase: "v2", deferredBy: "u1", deferredAt: "2026-10-06T10:00:00Z" },
    }) as unknown as RequirementDetail;

  it("asks why it comes back, sends nothing until it is said, and sends the reason", async () => {
    const calls = fakeCore(() => ({ body: detail([]) }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={deferred()} />);
    await user.click(screen.getByRole("button", { name: "Undefer" }));
    expect(calls).toEqual([]);
    const submit = screen.getByRole("button", { name: "Undefer" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Why it comes back into the release"), "  planned into v1 after all ");
    await user.click(submit);
    await waitFor(() =>
      expect(calls).toContainEqual({ method: "POST", path: "/projects/p1/requirements/REQ-2/undefer", body: { reason: "planned into v1 after all" } }),
    );
  });

  it("asks it in the viewer's language", async () => {
    fakeCore(() => undefined);
    const user = userEvent.setup();
    const vi = productCopy("vi");
    renderWithQuery(
      <InterfaceLanguageScope language="vi">
        <PrimaryActions projectId="p1" slug="epod" d={deferred()} />
      </InterfaceLanguageScope>,
    );
    await user.click(screen.getByRole("button", { name: vi("requirements.act.undefer") }));
    expect(screen.getByLabelText(vi("requirements.act.undeferWhyLabel"))).toBeInTheDocument();
  });
});
