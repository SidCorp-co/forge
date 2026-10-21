// REQ-49 on the item's page: a mockup opens full screen from its row (BC-1), a person pins a comment
// to a point or a region of it, stored as fractions of the frame, and each comment says where it
// points (BC-2); its revisions are listed and an earlier one stays readable, and a returned one is
// proposed again naming the comments it answers or resolves (BC-3); the requirement page lists its
// mockups under its properties with Add mockup (BC-7).

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import type { MockupCommentView, MockupView } from "../types";
import { MockupList } from "./mockups-panel";
import { RequirementMockups } from "./requirement-mockups";

const PAGE = "<!doctype html><button>0</button>";

const view = (key: string, over: Partial<MockupView> = {}): MockupView => ({
  id: key,
  key,
  target: { type: "requirement", key: "REQ-1", revision: 1 },
  kind: "html",
  name: `${key}.html`,
  mime: "text/html",
  size: 10,
  caption: null,
  status: "proposed",
  proposedBy: "u1",
  proposedByName: "Bo",
  proposedAgency: "human",
  createdAt: "2026-10-21T08:00:00.000Z",
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  reason: null,
  pinned: null,
  round: 1,
  revises: null,
  revisedBy: null,
  comments: { total: 0, open: 0 },
  url: `/api/projects/p1/mockups/${key}/content`,
  can: {
    accept: true,
    return: true,
    withdraw: false,
    comment: true,
    revise: false,
  },
  ...over,
});

const comment = (
  id: string,
  over: Partial<MockupCommentView> = {},
): MockupCommentView => ({
  id,
  on: "MK-1",
  body: `Comment ${id}`,
  pin: null,
  authorId: "u2",
  authorName: "Ann",
  authorAgency: "human",
  createdAt: "2026-10-21T08:10:00.000Z",
  settled: null,
  ...over,
});

function core(rows: MockupView[], thread: MockupCommentView[] = []) {
  return fakeCore((c: Call) => {
    if (c.method === "GET" && c.path.endsWith("/comments"))
      return {
        body: {
          comments: thread,
          open: thread.filter((t) => !t.settled).length,
        },
      };
    if (c.method === "GET" && c.path.includes("/content"))
      return { file: PAGE, headers: { "content-type": "text/html" } };
    if (c.method === "GET")
      return {
        body: {
          mockups: rows,
          returned: rows.length,
          open: rows.filter((r) => r.status === "proposed").length,
        },
      };
    if (c.path.endsWith("/comments"))
      return {
        status: 201,
        body: {
          comment: comment("new", { body: (c.body as { body: string }).body }),
        },
      };
    return { status: 201, body: { mockup: rows[0] } };
  });
}

const list = () =>
  renderWithQuery(
    <MockupList
      projectId="p1"
      slug="acme"
      target={{ type: "requirement", key: "REQ-1" }}
    />,
  );
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

// the pin layer reads its own box; jsdom draws none, so the frame is 1000 x 500 here
function frameBox() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 1000,
    height: 500,
    right: 1000,
    bottom: 500,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

beforeEach(() =>
  window.history.replaceState(null, "", "/projects/acme/requirements/REQ-1"),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("opening a mockup full screen (BC-1)", () => {
  it("opens from its row, names it in the address, and runs it in the isolated frame", async () => {
    core([view("MK-1")]);
    list();
    fireEvent.click(await screen.findByTestId("mockup-open"));
    const viewer = await screen.findByTestId("mockup-viewer");
    expect(viewer).toHaveAttribute("data-key", "MK-1");
    expect(new URLSearchParams(window.location.search).get("mockup")).toBe(
      "MK-1",
    );
    const frame = await within(viewer).findByTestId("mockup-html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    // the feedback form is the workspace's to hand down (MockupFeedbackSlot); none here, so no act
    expect(within(viewer).queryByTestId("mockup-feedback-open")).toBeNull();
    fireEvent.click(within(viewer).getByTestId("mockup-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("mockup-viewer")).toBeNull(),
    );
    expect(window.location.search).toBe("");
  });
});

describe("a comment pinned to the frame (BC-2)", () => {
  it("pins a press as a point and a drag as a region, as fractions of the frame", async () => {
    const calls = core([view("MK-1")]);
    window.history.replaceState(null, "", "?mockup=MK-1&full=1");
    list();
    const viewer = await screen.findByTestId("mockup-viewer");
    frameBox();
    const layer = within(viewer).getByTestId("mockup-pin-layer");
    fireEvent.click(within(viewer).getByTestId("mockup-pin-toggle"));
    fireEvent.pointerDown(layer, { clientX: 250, clientY: 250 });
    fireEvent.pointerUp(layer, { clientX: 251, clientY: 250 });
    expect(within(viewer).getByTestId("mockup-pin-draft")).toHaveTextContent(
      "Point at 25% across, 50% down",
    );
    fireEvent.change(within(viewer).getByRole("textbox", { name: "Comment" }), {
      target: { value: "Make this green" },
    });
    fireEvent.click(within(viewer).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toEqual({
      method: "POST",
      path: "/projects/p1/mockups/MK-1/comments",
      body: { body: "Make this green", pin: { x: 0.25, y: 0.5 } },
    });

    fireEvent.click(within(viewer).getByTestId("mockup-pin-toggle"));
    fireEvent.pointerDown(layer, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(layer, { clientX: 600, clientY: 300 });
    fireEvent.pointerUp(layer, { clientX: 600, clientY: 300 });
    fireEvent.change(within(viewer).getByRole("textbox", { name: "Comment" }), {
      target: { value: "Too cramped" },
    });
    fireEvent.click(within(viewer).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[1]?.body).toEqual({
      body: "Too cramped",
      pin: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
    });
  });

  it("shows each comment where it points, its mark on the frame, and how a revision settled it", async () => {
    core(
      [view("MK-1")],
      [
        comment("a", { pin: { x: 0.25, y: 0.5 } }),
        comment("b", { pin: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } }),
        comment("c", {
          settled: {
            as: "resolved",
            by: "MK-2",
            note: "out of scope",
            at: "2026-10-21T09:00:00.000Z",
          },
        }),
      ],
    );
    window.history.replaceState(null, "", "?mockup=MK-1&full=1");
    list();
    const viewer = await screen.findByTestId("mockup-viewer");
    const rows = await within(viewer).findAllByTestId("mockup-comment");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Point at 25% across, 50% down"),
      expect.stringContaining(
        "Region at 10% across, 20% down, 50% wide, 40% high",
      ),
      expect.stringContaining("Resolved by MK-2 — out of scope"),
    ]);
    const marks = within(viewer).getAllByTestId("mockup-pin");
    expect(
      marks.map((m) => [m.dataset.n, m.style.left, m.style.top, m.style.width]),
    ).toEqual([
      ["1", "25%", "50%", ""],
      ["2", "10%", "20%", "50%"],
    ]);
  });
});

describe("revisions (BC-3)", () => {
  const first = view("MK-1", {
    status: "returned",
    reason: "colour",
    revisedBy: "MK-2",
    can: {
      accept: false,
      return: false,
      withdraw: false,
      comment: false,
      revise: false,
    },
  });
  const second = view("MK-2", { round: 2, revises: "MK-1" });

  it("lists every revision, and an earlier one stays readable beside the one shown", async () => {
    core([first, second]);
    window.history.replaceState(null, "", "?mockup=MK-2&full=1");
    list();
    const viewer = await screen.findByTestId("mockup-viewer");
    const revisions = within(viewer).getAllByTestId("mockup-revision");
    expect(revisions.map((r) => r.dataset.key)).toEqual(["MK-1", "MK-2"]);
    fireEvent.click(revisions[0]);
    await waitFor(() =>
      expect(screen.getByTestId("mockup-viewer")).toHaveAttribute(
        "data-key",
        "MK-1",
      ),
    );
    expect(screen.getByTestId("mockup-viewer")).toHaveTextContent(
      "Comments go on its next revision, MK-2.",
    );
  });

  it("proposes a returned one again, answering one comment and resolving another with its note", async () => {
    const returned = view("MK-1", {
      status: "returned",
      reason: "colour",
      can: {
        accept: false,
        return: false,
        withdraw: false,
        comment: true,
        revise: true,
      },
    });
    const calls = core(
      [returned],
      [comment("a", { pin: { x: 0.5, y: 0.5 } }), comment("b")],
    );
    list();
    fireEvent.click(await screen.findByTestId("mockup-revise-open"));
    const form = await screen.findByTestId("mockup-revise");
    await within(form).findAllByRole("combobox");
    fireEvent.change(within(form).getByTestId("mockup-revise-file"), {
      target: {
        files: [new File([PAGE], "cart-2.html", { type: "text/html" })],
      },
    });
    const [, second] = within(form).getAllByRole("combobox");
    fireEvent.change(second, { target: { value: "resolved" } });
    const notes = within(form).getAllByRole("textbox", {
      name: "Note (optional)",
    });
    fireEvent.change(notes[1], { target: { value: "out of scope" } });
    fireEvent.click(
      within(form).getByRole("button", { name: "Propose revision" }),
    );
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toMatchObject({
      revises: "MK-1",
      kind: "html",
      name: "cart-2.html",
      answers: [{ comment: "a" }],
      resolves: [{ comment: "b", note: "out of scope" }],
    });
  });
});

describe("the requirement page's mockups under its properties (BC-7)", () => {
  it("lists each mockup's newest revision, and Add mockup proposes one on the requirement", async () => {
    const calls = core([
      view("MK-1", { status: "returned", revisedBy: "MK-2" }),
      view("MK-2", {
        round: 2,
        revises: "MK-1",
        comments: { total: 2, open: 1 },
      }),
    ]);
    renderWithQuery(
      <RequirementMockups projectId="p1" slug="acme" reqKey="REQ-1" />,
    );
    const items = await screen.findAllByTestId("requirement-mockup");
    expect(items.map((i) => i.dataset.key)).toEqual(["MK-2"]);
    expect(items[0]).toHaveTextContent("Revision 2");
    expect(items[0]).toHaveTextContent("1 open comments");
    fireEvent.click(screen.getByTestId("requirement-mockup-add"));
    fireEvent.change(screen.getByTestId("mockup-file"), {
      target: { files: [new File([PAGE], "new.html", { type: "text/html" })] },
    });
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toMatchObject({
      target: { requirement: "REQ-1" },
      kind: "html",
    });
    fireEvent.click(items[0]);
    expect(await screen.findByTestId("mockup-viewer")).toHaveAttribute(
      "data-key",
      "MK-2",
    );
  });
});
