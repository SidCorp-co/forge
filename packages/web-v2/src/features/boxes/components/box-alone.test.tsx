// ISS-1325 c2, c3, c4: a box at its own address opens its screen alone, full viewport, with the bar the
// full screen keeps; Take control there goes through the take door and the screen reads the answer;
// Exit opens the Boxes page on it. A closed box says so and plays the clip its span kept, or says it
// kept none; a box the reader may not see is refused by core's code. ISS-1338 c1, c2: a closed box
// plays the whole session a person asked to record beside its span clips, and one that could not come
// says why in its own words, never No clip alone. Core and the sockets are stood in for.

import { BOX_ROUTES, type BoxRecord, type BoxSessionRecording, type BoxSpanRecord } from "@forge/contracts/boxes";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boxCore, FakeSocket, routeOf } from "@/test/box-sockets";
import { BOX, ISSUE, ME, PROJECT_ID, projectBoxes } from "@/test/boxes";
import { renderWithQuery } from "@/test/render";
import { BoxAlone } from "./box-alone";
import { IssueBox } from "./issue-box";

vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const CLIP = "c11p0000-0000-4000-8000-000000000031";
const OLDER = "c11p0000-0000-4000-8000-000000000030";
const keptClip = (criterion: number, clip: string | null): BoxSpanRecord => ({
  id: `5a${criterion}00000-0000-4000-8000-000000000021`,
  boxId: BOX.done,
  issueId: ISSUE.login,
  criterion,
  state: clip ? "attached" : "failed",
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  endedAt: new Date(Date.now() - 100_000).toISOString(),
  clipAttachmentId: clip,
  stillAttachmentId: null,
  detail: null,
});

const SESSION_CLIP = "5e55c11p-0000-4000-8000-000000000041";
const SESSION_STILL = "5e55c11p-0000-4000-8000-000000000042";
/** The project's boxes, the closed one holding its session recording as `session` says. */
const withSession = (session: Omit<BoxSessionRecording, "at">): BoxRecord[] =>
  projectBoxes().map((b) => (b.id === BOX.done && b.recording ? { ...b, recording: { ...b.recording, session: { ...session, at: new Date().toISOString() } } } : b));

beforeEach(() => {
  FakeSocket.opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  window.history.replaceState(null, "", `/projects/orvio/boxes/${BOX.admin}`);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("a box at its own address", () => {
  it("opens its screen alone with the bar, takes control through the take door, and Exit opens the Boxes page on it", async () => {
    const admin = projectBoxes().find((b) => b.id === BOX.admin);
    const taken = { ...admin, state: "person", holder: { kind: "person", userId: ME, name: "Me" }, heldSince: new Date().toISOString() };
    const calls = boxCore(projectBoxes(), (c) => (c.method === "POST" && c.path === routeOf(BOX_ROUTES.take, BOX.admin) ? { body: { box: taken } } : undefined));
    renderWithQuery(<BoxAlone boxId={BOX.admin} slug="orvio" canWriteIn={() => true} />);
    const alone = await screen.findByTestId("box-screen");
    expect(alone).toHaveAttribute("data-mode", "fill");
    // the screen alone: no list, no feed, no page around it
    expect(screen.queryByTestId("box-list")).toBeNull();
    expect(screen.queryByTestId("box-feed")).toBeNull();
    expect(screen.getByTestId("box-view")).toHaveAttribute("data-fit", "screen");
    const bar = within(screen.getByTestId("box-screen-bar"));
    await bar.findByText("ISS-7 · Shift report (admin)");
    expect(calls.some((c) => c.method === "GET" && c.path === routeOf(BOX_ROUTES.get, BOX.admin))).toBe(true);

    fireEvent.click(bar.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === routeOf(BOX_ROUTES.take, BOX.admin))).toBe(true));
    await bar.findByRole("button", { name: "Hand back" });

    fireEvent.click(bar.getByRole("button", { name: "Exit" }));
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/projects/orvio/boxes?box=${BOX.admin}`);
  });

  it("offers a reader who may not write no Take control", async () => {
    boxCore(projectBoxes());
    renderWithQuery(<BoxAlone boxId={BOX.admin} slug="orvio" canWriteIn={() => false} />);
    const bar = within(await screen.findByTestId("box-screen-bar"));
    expect(bar.getByRole("button", { name: "Exit" })).toBeTruthy();
    expect(bar.queryByRole("button", { name: "Take control" })).toBeNull();
  });

  it("says a closed box is closed and plays the clip its span kept, the newest first", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:clip", revokeObjectURL: () => undefined }));
    const calls = boxCore(
      projectBoxes(),
      (c) => (c.path.startsWith("/attachments/") ? { file: "webm", headers: { "content-type": "video/webm" } } : undefined),
      () => [keptClip(1, OLDER), keptClip(2, null), keptClip(3, CLIP)],
    );
    renderWithQuery(<BoxAlone boxId={BOX.done} slug="orvio" canWriteIn={() => true} />);
    const ended = await screen.findByTestId("box-ended");
    expect(ended).toHaveAttribute("data-state", "closed");
    expect(within(ended).getByText("Box closed")).toBeTruthy();
    const clip = await within(ended).findByTestId("box-clip");
    expect(clip).toHaveAttribute("src", "blob:clip");
    expect(clip).toHaveAttribute("aria-label", "ISS-5 · Owner sign-in · C3");
    expect(calls.some((c) => c.path === `/attachments/${CLIP}/download`)).toBe(true);
    // each kept clip is a press away, the newest first; a span that kept none offers nothing
    expect(within(ended).getAllByRole("button").map((b) => b.textContent)).toEqual(["C3", "C1"]);
    fireEvent.click(within(ended).getByRole("button", { name: "C1" }));
    await waitFor(() => expect(within(ended).getByTestId("box-clip")).toHaveAttribute("aria-label", "ISS-5 · Owner sign-in · C1"));
    expect(calls.some((c) => c.path === `/attachments/${OLDER}/download`)).toBe(true);
    // a closed box asks no ticket: nothing is live to watch
    expect(calls.some((c) => c.path.endsWith("/ticket"))).toBe(false);
  });

  it("says a closed box kept no clip where none of its spans did", async () => {
    boxCore(projectBoxes(), undefined, () => []);
    renderWithQuery(<BoxAlone boxId={BOX.done} slug="orvio" canWriteIn={() => true} />);
    const ended = await screen.findByTestId("box-ended");
    expect(within(ended).getByText("Box closed")).toBeTruthy();
    await within(ended).findByText("No clip");
  });

  it("plays the whole session a person asked to record first, beside the clips its spans kept", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:clip", revokeObjectURL: () => undefined }));
    const calls = boxCore(
      withSession({ state: "attached", clipAttachmentId: SESSION_CLIP, stillAttachmentId: SESSION_STILL, fault: null, detail: null }),
      (c) => (c.path.startsWith("/attachments/") ? { file: "webm", headers: { "content-type": "video/webm" } } : undefined),
      () => [keptClip(1, OLDER), keptClip(3, CLIP)],
    );
    renderWithQuery(<BoxAlone boxId={BOX.done} slug="orvio" canWriteIn={() => true} />);
    const ended = await screen.findByTestId("box-ended");
    await waitFor(() => expect(within(ended).getAllByRole("button").map((b) => b.textContent)).toEqual(["Session", "C3", "C1"]));
    const clip = await within(ended).findByTestId("box-clip");
    expect(clip).toHaveAttribute("aria-label", "ISS-5 · Owner sign-in · Session");
    expect(calls.some((c) => c.path === `/attachments/${SESSION_CLIP}/download`)).toBe(true);
    fireEvent.click(within(ended).getByRole("button", { name: "C3" }));
    await waitFor(() => expect(within(ended).getByTestId("box-clip")).toHaveAttribute("aria-label", "ISS-5 · Owner sign-in · C3"));
    expect(within(ended).queryByTestId("box-session")).toBeNull();
  });

  it("says a session recording past the size limit is too large, the why on hover, never No clip alone", async () => {
    const detail = "the recording is 31457280 bytes at its smallest, over the 10485760 a box sends to Forge";
    boxCore(withSession({ state: "failed", clipAttachmentId: null, stillAttachmentId: null, fault: "TOO_LARGE", detail }), undefined, () => []);
    renderWithQuery(<BoxAlone boxId={BOX.done} slug="orvio" canWriteIn={() => true} />);
    const ended = await screen.findByTestId("box-ended");
    const line = await within(ended).findByTestId("box-session");
    expect(line).toHaveTextContent("Session · Too large");
    expect(line).toHaveAttribute("title", detail);
    expect(within(ended).queryByText("No clip")).toBeNull();
  });

  it("says a session recording on its way is sending", async () => {
    boxCore(withSession({ state: "sending", clipAttachmentId: null, stillAttachmentId: null, fault: null, detail: null }), undefined, () => []);
    renderWithQuery(<BoxAlone boxId={BOX.done} slug="orvio" canWriteIn={() => true} />);
    const line = await screen.findByTestId("box-session");
    expect(line).toHaveTextContent("Session · Sending");
    expect(screen.queryByText("No clip")).toBeNull();
  });

  // core answers a reader outside the box's project as it answers a box that is not there: not found
  it("refuses a box the reader may not see by core's code, in the app's words for it, never a blank page", async () => {
    boxCore([], (c) => (c.path === routeOf(BOX_ROUTES.get, BOX.admin) ? { status: 404, body: { error: { code: "NOT_FOUND", message: "box not found" } } } : undefined));
    renderWithQuery(<BoxAlone boxId={BOX.admin} slug="orvio" canWriteIn={() => true} />);
    const refused = await screen.findByTestId("box-alone-refused");
    expect(within(refused).getByText("Can't open box")).toBeTruthy();
    const line = within(refused).getByTestId("box-alone-refusal");
    expect(line).toHaveTextContent("NOT_FOUND");
    expect(line).toHaveTextContent("Not found.");
    expect(screen.queryByTestId("box-screen")).toBeNull();
  });

  it("is where an issue's Watch link and its Reproduce lead: the box's screen, not the whole Boxes page", async () => {
    const opened = { ...projectBoxes().find((b) => b.id === BOX.admin), id: BOX.mine, issueId: ISSUE.rewards, state: "opening" };
    boxCore(projectBoxes(), (c) => (c.method === "POST" && c.path === routeOf(BOX_ROUTES.ofProject, PROJECT_ID) ? { status: 201, body: { box: opened } } : undefined));
    renderWithQuery(<IssueBox projectId={PROJECT_ID} issueId={ISSUE.rewards} slug="orvio" canWrite />);
    const watch = await screen.findByRole("link", { name: "Watch" });
    expect(watch).toHaveAttribute("href", `/projects/orvio/boxes/${BOX.android}`);
    fireEvent.submit(screen.getByTestId("box-open"));
    await waitFor(() => expect(window.location.pathname).toBe(`/projects/orvio/boxes/${BOX.mine}`));
  });
});
