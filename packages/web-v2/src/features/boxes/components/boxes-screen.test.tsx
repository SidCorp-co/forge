// ISS-1276 c5, c7, ISS-1321 c2, c4: a project's Boxes page as a person reads and drives it. Core is stood in for over
// `fetch` with the contracts' own `BOX_ROUTES`; the view and input sockets are stood in for, so no
// test reaches a box.

import { BOX_ROUTES } from "@forge/contracts/boxes";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { androidActs, androidSpans, BOX, heldActs, ISSUE_LABELS, ME, PROJECT_ID, projectBoxes } from "@/test/boxes";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { BoxesScreen } from "./boxes-screen";

vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));

const path = (route: string, id: string) => route.replace(":id", id).replace(/^\/api/, "");

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static opened: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  onmessage: null | ((e: { data: string }) => void) = null;
  onclose: unknown = null;
  onopen: unknown = null;
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  send() {}
  close() {}
}

/** WebCodecs as a browser that has them offers it: the android view mounts, decoding nothing here. */
export class FakeDecoder {
  static isConfigSupported = () => Promise.resolve({ supported: true });
  state = "unconfigured";
  configure() {}
  decode() {}
  close() {
    this.state = "closed";
  }
}

function core(boxes = projectBoxes(), extra: (c: Call) => { status?: number; body: unknown } | undefined = () => undefined) {
  return fakeCore((c) => {
    const hit = extra(c);
    if (hit) return hit;
    if (c.method === "GET" && c.path === path(BOX_ROUTES.ofProject, PROJECT_ID)) return { body: { boxes } };
    const issue = /^\/issues\/([^/?]+)$/.exec(c.path)?.[1];
    if (issue && ISSUE_LABELS[issue]) return { body: ISSUE_LABELS[issue] };
    if (c.path === path(BOX_ROUTES.acts, BOX.android)) return { body: { acts: androidActs() } };
    if (c.path === path(BOX_ROUTES.acts, BOX.held)) return { body: { acts: heldActs() } };
    if (c.path === path(BOX_ROUTES.spans, BOX.android)) return { body: { spans: androidSpans() } };
    if (c.path.endsWith("/acts")) return { body: { acts: [] } };
    if (c.path.endsWith("/spans")) return { body: { spans: [] } };
    if (c.method === "POST" && c.path.endsWith("/ticket")) return { body: { ticket: "t", expiresAt: new Date().toISOString(), url: "/ws/boxes/view?ticket=t" } };
    return undefined;
  });
}

const selectBox = (id: string) => window.history.replaceState(null, "", `/projects/orvio/boxes?box=${id}`);

beforeEach(() => {
  FakeSocket.opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("the Boxes page", () => {
  it("lists the project's boxes and, apart, the requests waiting in their places with the health reason each waits on", async () => {
    core();
    renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    const list = await screen.findByTestId("box-list");
    expect(within(list).getAllByTestId("box-row").map((r) => r.dataset.state)).toEqual(["agent", "person", "agent", "closed"]);
    await within(list).findByText("ISS-12 · Redeem points at the counter");
    const queue = screen.getByTestId("box-queue");
    const waiting = within(queue).getAllByTestId("box-queue-row");
    // each in its place, its mode beside it, and the health reason it waits on behind its place
    expect(waiting.map((w) => [within(w).getByTestId("box-queue-place").dataset.reason, w.textContent?.replace(w.querySelector(".sr-only")?.textContent ?? "", "")])).toEqual([
      ["available memory 12 GB is under the 16 GB reserve", "#1ISS-14 · Bill does not printAndroid"],
      ["CPU pressure 82% is over the 70% ceiling", "#2ISS-15 · Menu photosBrowser"],
    ]);
    const band = screen.getByTestId("boxes-band");
    expect(within(band).getAllByTestId("band-figure-value").map((v) => v.textContent)).toEqual(["3", "1", "2"]);
  });

  it("names who holds a held box and since when, and counts its idle hold down", async () => {
    core();
    selectBox(BOX.held);
    renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    const held = await screen.findByTestId("box-held-by");
    expect(held.textContent).toMatch(/^Chuong since \d{1,2}:\d{2}/);
    expect(screen.getByTestId("box-idle").textContent).toMatch(/^Back to agent in [0-4]:\d{2}$/);
    const row = screen.getAllByTestId("box-row").find((r) => r.dataset.state === "person");
    expect(row && within(row).getByTestId("box-row-line").textContent).toMatch(/^Browser · Chuong · 1:4\d$/);
    // a box someone else holds offers no take and no hand back: only the holder hands it back
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hand back" })).toBeNull();
  });

  it("shows the agent's act refused while a person holds the box as Refused in the feed, its code on hover", async () => {
    core();
    selectBox(BOX.held);
    renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    await waitFor(() => expect(screen.getAllByTestId("box-feed-line")).toHaveLength(2));
    const [tap, refused] = screen.getAllByTestId("box-feed-line");
    if (!tap || !refused) throw new Error("the feed drew fewer than two lines");
    expect(tap.dataset.by).toBe("person");
    expect(refused.dataset.state).toBe("refused");
    expect(refused).toHaveTextContent("click @e9");
    expect(within(refused).getByTitle("BOX_HELD_BY_PERSON")).toHaveTextContent("Refused");
    expect(refused).toHaveAttribute("aria-current", "step");
  });

  it("takes control with the seam's take route, and the holder hands back with its release route", async () => {
    const taken = { ...projectBoxes().find((b) => b.id === BOX.android), state: "person", holder: { kind: "person", userId: ME, name: "Me" }, heldSince: new Date().toISOString() };
    const calls = core(projectBoxes(), (c) => (c.method === "POST" && c.path === path(BOX_ROUTES.take, BOX.android) ? { body: { box: taken } } : undefined));
    selectBox(BOX.android);
    vi.stubGlobal("VideoDecoder", FakeDecoder);
    vi.stubGlobal("EncodedVideoChunk", class {});
    const first = renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    fireEvent.click(await screen.findByRole("button", { name: "Take control" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === path(BOX_ROUTES.take, BOX.android))).toBe(true));
    first.unmount();

    const mine = projectBoxes(Date.now(), true);
    const released = { ...mine.find((b) => b.id === BOX.held), state: "agent", holder: { kind: "agent", runId: "run-qa" } };
    const again = core(mine, (c) => (c.method === "POST" && c.path === path(BOX_ROUTES.release, BOX.held) ? { body: { box: released } } : undefined));
    selectBox(BOX.held);
    renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    fireEvent.click(await screen.findByRole("button", { name: "Hand back" }));
    // the view says hello, and only then does the holder's input layer lie over it
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0));
    const hello = { type: "hello", boxId: BOX.held, codec: "jpeg-frames", width: 390, height: 844, fps: 10, holder: `person:${ME}`, watchOnly: true };
    act(() => FakeSocket.opened.at(-1)?.onmessage?.({ data: JSON.stringify(hello) }));
    await screen.findByTestId("box-input");
    await waitFor(() => expect(again.some((c) => c.method === "POST" && c.path === path(BOX_ROUTES.release, BOX.held))).toBe(true));
    // the holder's view carries the input layer, entered with its own input ticket
    expect(again.some((c) => c.method === "POST" && c.path === path(BOX_ROUTES.ticket, BOX.held) && (c.body as { channel?: string }).channel === "input")).toBe(true);
  });

  it("says whether a box records and why, and its toggle starts and stops it with the seam's recording route", async () => {
    const calls = core(projectBoxes(), (c) => (c.method === "POST" && c.path.endsWith("/recording") ? { body: { box: projectBoxes().find((b) => c.path.includes(b.id)) } } : undefined));
    selectBox(BOX.admin);
    const first = renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    const off = await screen.findByTestId("box-recording");
    expect(off).toHaveTextContent("Not recording");
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === path(BOX_ROUTES.recording, BOX.admin))?.body).toEqual({ on: true }));
    first.unmount();

    selectBox(BOX.android);
    vi.stubGlobal("VideoDecoder", FakeDecoder);
    vi.stubGlobal("EncodedVideoChunk", class {});
    renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    const on = await screen.findByTestId("box-recording");
    expect(on.textContent).toMatch(/^● Recording · 0:1\d · For a span$/);
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === path(BOX_ROUTES.recording, BOX.android))?.body).toEqual({ on: false }));
  });

  it("opens a box that records only when its Record box is ticked", async () => {
    const calls = core(projectBoxes(), (c) => (c.method === "POST" && c.path === path(BOX_ROUTES.ofProject, PROJECT_ID) ? { status: 201, body: { box: projectBoxes()[0] } } : undefined));
    renderWithQuery(<BoxesScreen projectId={PROJECT_ID} canWrite />);
    const form = await screen.findByTestId("box-open");
    fireEvent.submit(form);
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === path(BOX_ROUTES.ofProject, PROJECT_ID))).toHaveLength(1));
    fireEvent.click(within(form).getByRole("checkbox", { name: "Record" }));
    fireEvent.submit(form);
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === path(BOX_ROUTES.ofProject, PROJECT_ID))).toHaveLength(2));
    const [plain, recorded] = calls.filter((c) => c.method === "POST" && c.path === path(BOX_ROUTES.ofProject, PROJECT_ID)).map((c) => c.body as { record?: boolean });
    expect(plain?.record).toBeUndefined();
    expect(recorded?.record).toBe(true);
  });
});
