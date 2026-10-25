// REQ-69 BC-3, BC-5: a Product act the chat offers on an item is a card the person presses. The press
// goes to the route the item's page calls, as them; after it the card shows the item's new state, or
// why the act failed and what to do next, with the item's page one click away. A card whose item
// moved since the offer offers nothing.
// @direct-test-of packages/web-v2/src/features/conversations/act-offers.tsx

import type { ItemActOffer } from "@forge/contracts/item-acts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { useActOffers } from "./act-offers";
import type { ConversationMessage } from "./types";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const PROJECT = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
const REASON = "the export criteria are what sales asked for";

const agree: ItemActOffer = {
  v: 1,
  act: "requirement.agree",
  projectId: PROJECT,
  key: "REQ-3",
  ref: "REQ-3",
  title: "Export orders",
  from: "draft",
  revision: 2,
  reason: REASON,
};

const decline: ItemActOffer = {
  v: 1,
  act: "feedback.triage",
  projectId: PROJECT,
  key: "FB-12",
  ref: "FB-12",
  title: "Export button is grey",
  from: "new",
  triage: { route: "decline", note: "works as designed: export needs a filter first" },
};

const messageOf = (offer: ItemActOffer) =>
  ({
    id: "m1",
    blocks: [
      {
        type: "tool",
        toolCall: {
          id: "call-1",
          name: "offer_item_act",
          output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ offer }) }] }),
        },
      },
    ],
  }) as unknown as ConversationMessage;

function Thread({ offer }: { offer: ItemActOffer }) {
  const { offersFor } = useActOffers({ messages: [messageOf(offer)], progress: null, slug: "acme" });
  return <>{offersFor("m1")}</>;
}

const requirement = (status: string) => ({ key: "REQ-3", title: "Export orders", status, revisions: [{ revision: 2, state: "current" }] });

function core(state: { status: string; refuse?: boolean }): Call[] {
  return fakeCore((call) => {
    if (call.method === "GET" && call.path === `/projects/${PROJECT}/requirements/REQ-3`) return { body: requirement(state.status) };
    if (call.method === "POST" && call.path === `/projects/${PROJECT}/requirements/REQ-3/agree`) {
      if (state.refuse) {
        const detail = "this needs requirements.approve on the project";
        return { status: 403, body: { code: "PERMISSION_FORBIDDEN", message: detail, detail, error: { code: "PERMISSION_FORBIDDEN", message: detail } } };
      }
      state.status = "agreed";
      return { body: requirement("agreed") };
    }
    if (call.method === "GET" && call.path === `/projects/${PROJECT}/feedback/FB-12`) return { body: { feedback: { key: "FB-12", phase: "new" } } };
    if (call.method === "POST" && call.path === `/projects/${PROJECT}/feedback/FB-12/triage`) return { body: { feedback: { key: "FB-12", phase: "declined" } } };
    return { body: {} };
  });
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST").map((c) => ({ path: c.path, body: c.body }));

describe("a Product act the chat offers on an item", () => {
  it("says what it records, and one press agrees the requirement and shows its new state", async () => {
    const calls = core({ status: "draft" });
    const user = userEvent.setup();
    renderWithQuery(<Thread offer={agree} />);

    expect(await screen.findByText(/Agrees revision 2 of REQ-3/)).toBeTruthy();
    expect(screen.getByText(`“${REASON}”`)).toBeTruthy();
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    await user.click(confirm);
    await waitFor(() =>
      expect(posts(calls)).toEqual([{ path: `/projects/${PROJECT}/requirements/REQ-3/agree`, body: { revision: 2, reason: REASON } }]),
    );
    expect((await screen.findByTestId("item-act-done")).textContent).toMatch(/REQ-3 is now Agreed/);
  });

  it("says why a press failed and what to do next, with the item's page a click away", async () => {
    core({ status: "draft", refuse: true });
    const user = userEvent.setup();
    renderWithQuery(<Thread offer={agree} />);

    const confirm = await screen.findByRole("button", { name: "Confirm" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    await user.click(confirm);
    const failed = await screen.findByTestId("item-act-failed");
    expect(failed.textContent).toMatch(/requirements\.approve/);
    expect(failed.textContent).toMatch(/such as a project admin, can do it/);
    expect(screen.getByRole("link", { name: "Open REQ-3" }).getAttribute("href")).toBe("/projects/acme/requirements/REQ-3");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });

  it("offers nothing once the item has moved since the offer", async () => {
    const calls = core({ status: "agreed" });
    renderWithQuery(<Thread offer={agree} />);

    expect(await screen.findByText(/REQ-3 is at Agreed now/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(posts(calls)).toEqual([]);
  });

  it("declines feedback with its reason through the triage route, never filing anything else", async () => {
    const calls = core({ status: "draft" });
    const user = userEvent.setup();
    renderWithQuery(<Thread offer={decline} />);

    const confirm = await screen.findByRole("button", { name: "Confirm" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    await user.click(confirm);
    await waitFor(() =>
      expect(posts(calls)).toEqual([
        { path: `/projects/${PROJECT}/feedback/FB-12/triage`, body: { route: "decline", note: "works as designed: export needs a filter first" } },
      ]),
    );
    expect((await screen.findByTestId("item-act-done")).textContent).toMatch(/FB-12 is now/);
  });
});
