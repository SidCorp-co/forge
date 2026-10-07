// HOP ISS-125 (dev, 2026-10-07): core answered the New issue form's POST with a 201 and the form
// stayed open with its spinner turning five seconds later, because every write waited for the
// waiting-on-you counts to be read again. A filed issue closes the form, opens the issue and names
// it; a second submit while the first is in flight sends nothing, and the drawer cannot be closed
// and reopened to send one.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/providers/query-provider";
import { NeedsYouCounts } from "@/test/needs-you-counts";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { NewIssueDialog } from "./new-issue-dialog";

const push = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

const scope = { projectId: "p1", slug: "hop" };
const CREATED = { id: "i125", displayId: "ISS-125", attachments: [] };

// jsdom has no layout, and the description editor measures text ranges as it draws its placeholder
const rangeRects = Range.prototype.getClientRects;
beforeEach(() => {
  push.mockReset();
  toast.mockReset();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});
afterEach(() => {
  vi.unstubAllGlobals();
  Range.prototype.getClientRects = rangeRects;
});

/** Core answers the create at once (or never, with `hold`); the counts answer once, then never again. */
function core({ hold = false } = {}) {
  let counts = 0;
  return fakeCore((c: Call) => {
    if (c.method === "POST" && c.path === "/projects/p1/issues") return hold ? HANG : { status: 201, body: CREATED };
    if (c.path === "/projects/p1/needs-you") return ++counts === 1 ? { body: { items: [] } } : HANG;
    return undefined;
  });
}

function mount(onClose = vi.fn()) {
  renderWithQuery(
    <>
      <NeedsYouCounts projectId="p1" />
      <NewIssueDialog open onClose={onClose} scope={scope} />
    </>,
    createQueryClient(),
  );
  fireEvent.change(screen.getByPlaceholderText("Short summary of the issue"), { target: { value: "Root page is the theme demo" } });
  return onClose;
}

describe("the New issue form", () => {
  it("closes, opens the filed issue and names it once core answers 201, while the counts are still being re-read", async () => {
    const calls = core();
    const onClose = mount();
    await waitFor(() => expect(calls.some((c) => c.path === "/projects/p1/needs-you")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Create issue" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(push).toHaveBeenCalledWith("/projects/hop/issues/i125");
    expect(toast).toHaveBeenCalledWith({ title: "Issue created", description: "ISS-125", tone: "success" });
  });

  it("sends one create for two quick submits, with the button disabled until core answers", async () => {
    const calls = core({ hold: true });
    mount();
    const button = screen.getByRole("button", { name: "Create issue" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("cannot be dismissed while the create is in flight, so a reopened form cannot send a second", async () => {
    core({ hold: true });
    const onClose = mount();
    const button = screen.getByRole("button", { name: "Create issue" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
