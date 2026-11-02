// The feedback page's face (ISS-903): the title leads with its key the title's tooltip, never text
// beside it; the facts open in a Properties drawer, never a rail beside the page; the person /
// developer switch is the palette's, not a control on the face; and no act is drawn inline: the
// header's one act opens them in a sheet, the rarer two are the palette's, and Reproduce and Messages
// are one line each until opened.
//
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-detail.tsx
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-item-screen.tsx
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-acts.tsx
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-messages.tsx

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageCommandsProvider, usePageCommandList } from "@/design";
import { feedbackDetail, ITEM } from "@/test/vi-chrome-feedback";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

Element.prototype.scrollIntoView = () => {};

const NO_ACTS = Object.fromEntries(Object.keys(ITEM.can).map((k) => [k, false])) as typeof ITEM.can;

/** The page's palette acts as plain buttons: what ⌘K lists, run by a click. */
function PaletteActs() {
  return usePageCommandList().map((c) => (
    <button key={c.label} type="button" data-palette-act="" onClick={c.onRun}>
      {c.label}
    </button>
  ));
}

const withPalette = (page: ReturnType<typeof feedbackDetail>) => (
  <PageCommandsProvider>
    {page}
    <PaletteActs />
  </PageCommandsProvider>
);

afterEach(() => window.history.replaceState(null, "", "/"));

describe("the feedback page's face", () => {
  it("leads with the title, its key the tooltip", async () => {
    render(feedbackDetail());
    const title = await screen.findByTestId("feedback-title");
    expect(title).toHaveAttribute("title", ITEM.key);
    expect(title.textContent).toBe(ITEM.title);
    expect(screen.queryAllByText(ITEM.key, { exact: true })).toHaveLength(0);
  });

  it("opens the facts in a Properties drawer, and draws no view switch on the face", async () => {
    const user = userEvent.setup();
    render(feedbackDetail());
    await screen.findByTestId("feedback-detail");
    expect(screen.queryByTestId("record-view-switch")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByTestId("feedback-properties"));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "Properties" })).toBeInTheDocument();
  });

  it("draws no act inline: the header's Triage opens the suggested triage and the form in a sheet", async () => {
    const user = userEvent.setup();
    render(feedbackDetail());
    await screen.findByTestId("feedback-detail");
    for (const id of ["feedback-triage", "feedback-verify", "feedback-proposals", "feedback-retarget", "feedback-redact"]) {
      expect(screen.queryByTestId(id), `${id} is not on the page`).toBeNull();
    }
    await user.click(screen.getByTestId("feedback-primary"));
    const sheet = await screen.findByRole("dialog", { name: "Triage" });
    expect(within(sheet).getByTestId("feedback-triage")).toBeInTheDocument();
    expect(await within(sheet).findByTestId("feedback-proposals")).toBeInTheDocument();
    expect(window.location.hash).toBe("#feedback-act");
  });

  it("opens Confirm the fix from the header where core offers it and not triage", async () => {
    const user = userEvent.setup();
    render(feedbackDetail({ can: { ...NO_ACTS, verify: true, reopen: true } }));
    const primary = await screen.findByTestId("feedback-primary");
    expect(primary).toHaveTextContent("Confirm the fix");
    await user.click(primary);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByTestId("feedback-verify")).toBeInTheDocument();
    expect(within(sheet).queryByTestId("feedback-triage")).toBeNull();
  });

  it("opens the sheet from a link to its anchor, as the checklist's Answer is", async () => {
    render(feedbackDetail());
    await screen.findByTestId("feedback-detail");
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      window.location.hash = "#feedback-act";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(within(await screen.findByRole("dialog")).getByTestId("feedback-acts")).toBeInTheDocument();
  });

  it("draws no header act and no sheet where core offers none", async () => {
    render(feedbackDetail({ can: NO_ACTS }));
    await screen.findByTestId("feedback-detail");
    expect(screen.queryByTestId("feedback-primary")).toBeNull();
    expect(await screen.findByTestId("feedback-proposals"), "a reader with no act reads the suggestions on the page").toBeInTheDocument();
  });

  it("names Change what it is about and Delete reporter data for the palette, each opening its own sheet", async () => {
    const user = userEvent.setup();
    render(withPalette(feedbackDetail()));
    await screen.findByTestId("feedback-detail");
    const named = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-palette-act")).map((b) => b.textContent);
    expect(named).toEqual(expect.arrayContaining(["Change what it is about…", "Delete reporter data…"]));
    await user.click(screen.getByRole("button", { name: "Delete reporter data…" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("button", { name: "Delete reporter data" })).toBeInTheDocument();
  });

  it("names neither for the palette where core offers neither", async () => {
    render(withPalette(feedbackDetail({ can: { ...ITEM.can, retarget: false, redact: false } })));
    await screen.findByTestId("feedback-detail");
    expect(screen.queryByRole("button", { name: "Change what it is about…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete reporter data…" })).toBeNull();
  });

  it("shuts Reproduce and Messages to one line each, the composer inside Messages", async () => {
    const user = userEvent.setup();
    render(feedbackDetail());
    const messages = await screen.findByTestId("feedback-messages");
    const [line] = within(messages).getAllByRole("button");
    if (!line) throw new Error("Messages draws no line");
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(line).toHaveTextContent(`Messages${ITEM.messages.length}`);
    expect(within(screen.getByTestId("feedback-reproduce")).getAllByRole("button")[0]).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Reproduce FB/ })).toBeNull();
    expect(screen.queryByTestId("feedback-thread")).toBeNull();
    await user.click(line);
    expect(within(messages).getByTestId("feedback-thread")).toBeInTheDocument();
    expect(within(messages).getByRole("radio", { name: "Internal note" })).toBeInTheDocument();
  });
});
