// REQ-39 BC-3, BC-6, BC-9, BC-10 as a person sees them on the issue: the preview in a frame entered with
// a ticket, the reason a preview did not start, who may approve, and the box that asks the run for a
// change. Core is stood in for over `fetch` with the contracts' own routes, and each record is parsed
// by `previewRecordSchema`.

import { PREVIEW_FAILURE_REASONS, PREVIEW_ROUTES } from "@forge/contracts/preview";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import copy from "./copy.json";
import { HOST, ISSUE_ID, PREVIEW_ID, previewOf } from "./fixtures";
import { PreviewPanel } from "./preview-panel";

const PREVIEW = `/issues/${ISSUE_ID}/preview`;
const refusal = (code: string, message: string) => ({ error: { code, message, refusals: [] } });

type Reply = { status?: number; body: unknown } | undefined;

function core(handlers: Record<string, (c: Call) => Reply>): Call[] {
  return fakeCore((c) => handlers[`${c.method} ${c.path}`]?.(c));
}

function mount(props: Partial<React.ComponentProps<typeof PreviewPanel>> = {}) {
  return renderWithQuery(<PreviewPanel issueId={ISSUE_ID} issueLabel="ISS-491" canWrite hasLiveRun {...props} />);
}

afterEach(() => vi.unstubAllGlobals());

describe("the preview on the issue", () => {
  it("draws nothing where there is no preview and nothing a reader could start", async () => {
    const calls = core({ [`GET ${PREVIEW}`]: () => ({ status: 404, body: refusal("PREVIEW_NOT_FOUND", "none") }) });
    const { container } = mount({ canWrite: false });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(container.querySelector("[data-testid=preview-panel]")).toBeNull());
    expect(screen.queryByRole("button", { name: "Start preview" })).toBeNull();
  });

  it("offers Start preview to a writer whose run holds a worktree, and opens it with one POST", async () => {
    const calls = core({
      [`GET ${PREVIEW}`]: () => ({ status: 404, body: refusal("PREVIEW_NOT_FOUND", "none") }),
      [`POST ${PREVIEW}`]: () => ({ status: 201, body: previewOf({ state: "starting", liveAt: null }) }),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Start preview" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === PREVIEW)).toBe(true));
  });

  it("names a start refused by core, with core's own words", async () => {
    core({
      [`GET ${PREVIEW}`]: () => ({ status: 404, body: refusal("PREVIEW_NOT_FOUND", "none") }),
      [`POST ${PREVIEW}`]: () => ({ status: 422, body: refusal("PREVIEW_NO_RUN", "the issue has no live run holding a worktree") }),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Start preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't start the preview: the issue has no live run holding a worktree");
  });

  it("refuses a record it cannot read by name, never drawing a state it does not know", async () => {
    core({ [`GET ${PREVIEW}`]: () => ({ body: { ...previewOf(), state: "levitating" } }) });
    mount();
    const failed = await screen.findByTestId("preview-load-failed");
    expect(failed).toHaveTextContent("answered a preview this build cannot read");
    expect(failed).toHaveTextContent("state");
    expect(screen.queryByTestId("preview-frame")).toBeNull();
  });
});

describe("BC-3: the frame", () => {
  const live = () =>
    core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf() }),
      [`POST /previews/${PREVIEW_ID}/ticket`]: () => ({ body: { ticket: "tk-1" } }),
    });

  it("is entered through the preview host's enter path with a ticket, sandboxed without top navigation", async () => {
    const calls = live();
    mount();
    const frame = (await screen.findByTitle("Preview of ISS-491")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`${HOST}__forge_preview/enter?ticket=tk-1`);
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox.split(" ")).toEqual(["allow-scripts", "allow-same-origin", "allow-forms", "allow-popups", "allow-modals"]);
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(calls.filter((c) => c.path.endsWith("/ticket"))).toHaveLength(1);
  });

  it("opens in a tab of its own with a fresh ticket, the window opened before the ticket is asked for", async () => {
    let n = 0;
    const calls = core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf() }),
      [`POST /previews/${PREVIEW_ID}/ticket`]: () => ({ body: { ticket: `tk-${++n}` } }),
    });
    const tab = { opener: "kept", location: { href: "" }, close: vi.fn() };
    const open = vi.fn(() => tab);
    vi.stubGlobal("open", open);
    mount();
    await screen.findByTitle("Preview of ISS-491");
    fireEvent.click(screen.getByRole("button", { name: "Open in tab" }));
    await waitFor(() => expect(tab.location.href).toBe(`${HOST}__forge_preview/enter?ticket=tk-2`));
    expect(open).toHaveBeenCalledTimes(1);
    expect(tab.opener).toBeNull();
    expect(calls.filter((c) => c.path.endsWith("/ticket"))).toHaveLength(2);
  });

  it("says so, and offers the tab, when the browser never lets the frame load", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      live();
      mount();
      await screen.findByTitle("Preview of ISS-491");
      expect(screen.queryByTestId("preview-frame-slow")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(13_000);
      });
      expect(screen.getByTestId("preview-frame-slow")).toHaveTextContent("Open the preview in its own tab");
      fireEvent.load(screen.getByTitle("Preview of ISS-491"));
      await waitFor(() => expect(screen.queryByTestId("preview-frame-slow")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("names a ticket core refused, and draws no frame", async () => {
    core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf() }),
      [`POST /previews/${PREVIEW_ID}/ticket`]: () => ({ status: 403, body: refusal("PREVIEW_FORBIDDEN", "you are not a member of this project") }),
    });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open the preview: you are not a member of this project");
    expect(screen.queryByTitle("Preview of ISS-491")).toBeNull();
  });
});

describe("BC-10: a preview that cannot start says why", () => {
  it.each([
    ["NO_START_COMMAND", "No start command", /Set the preview command/],
    ["PORT_IN_USE", "Port in use", /Free the port/],
    ["DEV_SERVER_EXITED", "The dev server exited", /tail of its output/],
  ] as const)("%s names itself on the issue", async (reason, name, fix) => {
    core({ [`GET ${PREVIEW}`]: () => ({ body: previewOf({ state: "failed", reason, detail: "exit 1\nError: EADDRINUSE", closedAt: "2026-10-09T10:01:00.000Z" }) }) });
    mount();
    const note = await screen.findByTestId("preview-failure");
    expect(note).toHaveAttribute("data-reason", reason);
    expect(note).toHaveTextContent(name);
    expect(note).toHaveTextContent(fix);
    expect(screen.getByTestId("preview-failure-detail")).toHaveTextContent("Error: EADDRINUSE");
    expect(screen.queryByTestId("preview-frame")).toBeNull();
  });

  it("has a name and a fix in the copy for every reason the contract holds", () => {
    const en = copy.en as Record<string, string>;
    for (const reason of PREVIEW_FAILURE_REASONS) {
      expect(en[`previews.failed.reason.${reason}`], reason).toBeTruthy();
      expect(en[`previews.failed.fix.${reason}`], reason).toBeTruthy();
    }
  });

  it("says a failure that carries no reason is incomplete rather than drawing a blank", async () => {
    core({ [`GET ${PREVIEW}`]: () => ({ body: previewOf({ state: "failed", reason: null }) }) });
    mount();
    expect(await screen.findByText("The preview could not start or stopped answering.")).toBeInTheDocument();
  });

  it("offers Try again to a writer whose run is live, posting the open again", async () => {
    const calls = core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf({ state: "failed", reason: "DEV_SERVER_NOT_LISTENING", detail: "" }) }),
      [`POST ${PREVIEW}`]: () => ({ status: 201, body: previewOf({ state: "starting", liveAt: null }) }),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === PREVIEW)).toBe(true));
  });
});

describe("BC-9: a closed preview says which way it closed", () => {
  it("idle: names the minutes and reopens at the same link", async () => {
    const calls = core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf({ state: "idle_closed", idleMinutes: 45 }) }),
      [`POST ${PREVIEW}`]: () => ({ body: previewOf({ state: "starting", liveAt: null }) }),
    });
    mount();
    expect(await screen.findByText(/closed after 45 minutes with nobody viewing/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === PREVIEW)).toBe(true));
    expect(screen.queryByTitle("Preview of ISS-491")).toBeNull();
  });

  it("abandoned and approved: say so and offer no frame", async () => {
    core({ [`GET ${PREVIEW}`]: () => ({ body: previewOf({ state: "abandoned", detail: "the run ended" }) }) });
    mount();
    expect(await screen.findByText("This preview was abandoned. Its link is closed.")).toBeInTheDocument();
    expect(screen.getByText("the run ended")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-frame")).toBeNull();
  });
});

describe("approve, abandon and the lane", () => {
  it("approves with one POST on the preview, and names a refusal for a member who may not", async () => {
    const calls = core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf() }),
      [`POST /previews/${PREVIEW_ID}/ticket`]: () => ({ body: { ticket: "t" } }),
      [`POST /previews/${PREVIEW_ID}/approve`]: () => ({ status: 403, body: refusal("PREVIEW_FORBIDDEN", "approving a preview needs previews.approve") }),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't approve the preview: approving a preview needs previews.approve");
    expect(calls.filter((c) => c.path.endsWith("/approve"))).toHaveLength(1);
  });

  it("abandons with one POST", async () => {
    const calls = core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf() }),
      [`POST /previews/${PREVIEW_ID}/ticket`]: () => ({ body: { ticket: "t" } }),
      [`POST /previews/${PREVIEW_ID}/abandon`]: () => ({ body: previewOf({ state: "abandoned" }) }),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Abandon" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/abandon"))).toBe(true));
  });

  it("a reader who cannot write sees the frame and no act", async () => {
    core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf() }),
      [`POST /previews/${PREVIEW_ID}/ticket`]: () => ({ body: { ticket: "t" } }),
    });
    mount({ canWrite: false });
    await screen.findByTitle("Preview of ISS-491");
    for (const name of ["Approve", "Abandon", "Reopen"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByText(/needs write access to this project/)).toBeInTheDocument();
  });

  it("an approved preview shows the fast lane read", async () => {
    core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf({ state: "approved" }) }),
      [`GET /issues/${ISSUE_ID}/lane`]: () => ({ body: { issueId: ISSUE_ID, lane: "fast", decision: { lane: "fast", files: ["packages/web-v2/src/a.tsx"] }, approved: null, refusal: null } }),
    });
    mount();
    const lane = await screen.findByTestId("preview-lane");
    expect(lane).toHaveAttribute("data-lane", "fast");
    expect(lane).toHaveTextContent("typecheck, touched tests, merge, then a web-only deploy");
  });

  it("an approved preview on the full lane says why, in core's words", async () => {
    core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf({ state: "approved" }) }),
      [`GET /issues/${ISSUE_ID}/lane`]: () => ({
        body: { issueId: ISSUE_ID, lane: "full", decision: null, approved: null, refusal: { code: "FAST_LANE_NOT_ELIGIBLE", path: "/touched", detail: "packages/core/src/auth/x.ts (security)" } },
      }),
    });
    mount();
    const lane = await screen.findByTestId("preview-lane");
    expect(lane).toHaveAttribute("data-lane", "full");
    expect(lane).toHaveTextContent("Full lane: packages/core/src/auth/x.ts (security)");
  });
});

describe("BC-6: asking for a change in the preview", () => {
  const live = () =>
    core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf() }),
      [`POST /previews/${PREVIEW_ID}/ticket`]: () => ({ body: { ticket: "t" } }),
      [`POST /previews/${PREVIEW_ID}/messages`]: () => ({ status: 202, body: {} }),
    });

  it("sends the trimmed text to the preview's messages route, clears the box and says it was sent", async () => {
    const calls = live();
    mount();
    const box = await screen.findByRole("textbox", { name: "Ask for a change" });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    fireEvent.change(box, { target: { value: "  make the button green  " } });
    fireEvent.click(send);
    await waitFor(() => expect(calls.find((c) => c.path.endsWith("/messages"))?.body).toEqual({ text: "make the button green" }));
    expect(await screen.findByText(/Sent to the run/)).toBeInTheDocument();
    expect(box).toHaveValue("");
  });

  it("cannot send an empty or blank message", async () => {
    const calls = live();
    mount();
    const box = await screen.findByRole("textbox", { name: "Ask for a change" });
    fireEvent.change(box, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.submit(box.closest("form") as HTMLFormElement);
    expect(calls.some((c) => c.path.endsWith("/messages"))).toBe(false);
  });

  it("keeps the words and names core's refusal where the run is gone", async () => {
    core({
      [`GET ${PREVIEW}`]: () => ({ body: previewOf() }),
      [`POST /previews/${PREVIEW_ID}/ticket`]: () => ({ body: { ticket: "t" } }),
      [`POST /previews/${PREVIEW_ID}/messages`]: () => ({ status: 422, body: refusal("PREVIEW_NO_RUN", "the run holding this preview has ended") }),
    });
    mount();
    const box = await screen.findByRole("textbox", { name: "Ask for a change" });
    fireEvent.change(box, { target: { value: "bigger" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Couldn't send the message: the run holding this preview has ended/)).toBeInTheDocument();
    expect(box).toHaveValue("bigger");
  });

  it("is not offered to a reader without write access, and not on a closed preview", async () => {
    live();
    const { unmount } = mount({ canWrite: false });
    await screen.findByTitle("Preview of ISS-491");
    expect(screen.queryByRole("textbox", { name: "Ask for a change" })).toBeNull();
    unmount();
    core({ [`GET ${PREVIEW}`]: () => ({ body: previewOf({ state: "idle_closed" }) }) });
    mount();
    await screen.findByText(/closed after/);
    expect(screen.queryByRole("textbox", { name: "Ask for a change" })).toBeNull();
  });
});

describe("the contracts' own routes", () => {
  it("the paths this build calls are the ones PREVIEW_ROUTES names", () => {
    expect(PREVIEW_ROUTES.ofIssue).toBe(`/api${PREVIEW.replace(ISSUE_ID, ":issueId")}`);
    expect(PREVIEW_ROUTES.messages).toBe("/api/previews/:id/messages");
  });
});
