// REQ-41 BC-14, BC-15, BC-16 as a person sees them: the assistant's offer is a button that opens the
// idea beside the chat; Keep takes the page's snapshot from the frame and sends it with the sentence
// that says what it shows; a kept picture is drawn still on the requirement and reopens live from its head.
// Core is stood in for over `fetch` with the contracts' own routes.

import { PREVIEW_ROUTES } from "@forge/contracts/preview";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { PROJECT } from "@/test/requirement-pictures";
import { HOST, PREVIEW_ID, previewOf, ticketBody } from "./fixtures";

const asked = vi.hoisted(() => ({ calls: 0, answer: null as unknown }));
vi.mock("./idea-snapshot", async (orig) => {
  const real = await orig<typeof import("./idea-snapshot")>();
  return {
    ...real,
    askPageSnapshot: async () => {
      asked.calls += 1;
      if (asked.answer instanceof Error) throw asked.answer;
      return asked.answer;
    },
  };
});
const replayed = vi.hoisted(() => ({ events: null as unknown, paused: [] as unknown[], destroyed: 0 }));
vi.mock("rrweb", () => ({
  Replayer: class {
    constructor(events: unknown) {
      replayed.events = events;
    }
    pause(at: unknown) {
      replayed.paused.push(at);
    }
    destroy() {
      replayed.destroyed += 1;
    }
  },
}));
vi.mock("rrweb/dist/style.css", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/projects/hop", useParams: () => ({ slug: "hop" }) }));
vi.mock("@/features/projects/hooks", () => ({ useProjects: () => ({ data: [{ id: "7f1c1d1e-0000-4000-8000-000000000001", slug: "hop", role: "member" }] }) }));

const { IdeaPanel } = await import("./idea-panel");
const { KeptPreviewPicture } = await import("./idea-kept-picture");
const { SnapshotUnavailable } = await import("./idea-snapshot");

const SHA = "c".repeat(40);
const idea = (over = {}) =>
  previewOf({ subject: { kind: "idea", about: { kind: "requirement", key: "REQ-41" }, branch: "sketch/req-41-abcdef" }, issueId: null, ...over });
const PAIR = [
  { type: 4, timestamp: 1, data: { href: HOST, width: 800, height: 600 } },
  { type: 2, timestamp: 2, data: { node: { type: 0, childNodes: [] } } },
];
const refusal = (code: string, message: string) => ({ error: { code, message, refusals: [] } });
function core(handlers: Record<string, (c: Call) => { status?: number; body: unknown } | undefined>): Call[] {
  return fakeCore((c) => handlers[`${c.method} ${c.path}`]?.(c));
}

beforeEach(() => {
  asked.calls = 0;
  asked.answer = PAIR;
  replayed.events = null;
  replayed.paused = [];
  replayed.destroyed = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("keeping the idea (BC-16)", () => {
  const live = (extra: Record<string, (c: Call) => { status?: number; body: unknown } | undefined> = {}) =>
    core({
      [`GET /previews/${PREVIEW_ID}`]: () => ({ body: { preview: idea() } }),
      [`POST /previews/${PREVIEW_ID}/ticket`]: () => ({ body: ticketBody("tk-1") }),
      ...extra,
    });

  it("takes the page's snapshot from the frame and sends it with what the page shows, then says where it was kept", async () => {
    const calls = live({
      [`POST /previews/${PREVIEW_ID}/keep`]: () => ({
        status: 201,
        body: { requirement: "REQ-41", revision: 1, pictureId: "8df98619-9f7c-46b8-8e65-a67f2fcdce74", startedFrom: null, suggestionId: "1df98619-9f7c-46b8-8e65-a67f2fcdce74", suggestionRefusal: null },
      }),
    });
    renderWithQuery(<IdeaPanel preview={idea()} about="REQ-41" canWrite slug="hop" />);
    const keepBtn = await screen.findByRole("button", { name: "Keep as the picture" });
    expect(keepBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("What this page shows"), { target: { value: "The home with a larger chat box" } });
    fireEvent.click(keepBtn);
    await screen.findByTestId("idea-kept");
    expect(asked.calls).toBe(1);
    const sent = calls.find((c) => c.path === `/previews/${PREVIEW_ID}/keep`);
    expect(sent?.body).toEqual({ alt: "The home with a larger chat box", snapshot: PAIR });
    expect(screen.getByTestId("idea-kept")).toHaveTextContent("Kept as the picture of REQ-41.");
    expect(screen.getByTestId("idea-kept")).toHaveTextContent("Criteria drafted from what you asked are waiting");
  });

  it("says by name when the page gave no snapshot, and keeps nothing", async () => {
    asked.answer = new SnapshotUnavailable("silent", "the preview page did not answer: reload it and try again");
    const calls = live();
    renderWithQuery(<IdeaPanel preview={idea()} about="REQ-41" canWrite slug="hop" />);
    fireEvent.change(await screen.findByLabelText("What this page shows"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Keep as the picture" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't keep the preview: the preview page did not answer");
    expect(calls.some((c) => c.path.endsWith("/keep"))).toBe(false);
  });

  it("names core's refusal of the keep", async () => {
    live({ [`POST /previews/${PREVIEW_ID}/keep`]: () => ({ status: 409, body: refusal("PREVIEW_KEEP_NOT_IDEA", "preview serves an issue's run") }) });
    renderWithQuery(<IdeaPanel preview={idea()} about="REQ-41" canWrite slug="hop" />);
    fireEvent.change(await screen.findByLabelText("What this page shows"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Keep as the picture" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("preview serves an issue's run");
  });

  it("says where the criteria draft was refused instead of going quiet", async () => {
    live({
      [`POST /previews/${PREVIEW_ID}/keep`]: () => ({
        status: 201,
        body: { requirement: "REQ-41", revision: 1, pictureId: "8df98619-9f7c-46b8-8e65-a67f2fcdce74", startedFrom: "FB-61", suggestionId: null, suggestionRefusal: { code: "SUGGESTION_QUEUE_FULL", detail: "too many proposals wait" } },
      }),
    });
    renderWithQuery(<IdeaPanel preview={idea()} about="FB-61" canWrite slug="hop" />);
    fireEvent.change(await screen.findByLabelText("What this page shows"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Keep as the picture" }));
    const kept = await screen.findByTestId("idea-kept");
    expect(kept).toHaveTextContent("Started REQ-41 from FB-61");
    expect(screen.getByTestId("idea-criteria-refused")).toHaveTextContent("SUGGESTION_QUEUE_FULL: too many proposals wait");
  });
});

describe("a kept preview on the requirement (BC-16)", () => {
  const content = { previewId: PREVIEW_ID, branch: "sketch/req-41-abcdef", head: SHA, base: "a".repeat(40), patchId: "d".repeat(40), files: ["a.tsx", "b.tsx"], asked: ["A larger chat box"], snapshot: PAIR };

  it("draws the stored snapshot still, paused on it, and names the branch and head it was built on", async () => {
    renderWithQuery(<KeptPreviewPicture content={content as never} alt="The home with a larger chat box" projectId={PROJECT} reqKey="REQ-41" slug="hop" canWrite />);
    await waitFor(() => expect(screen.getByTestId("kept-preview-still")).toHaveAttribute("data-drawn", "drawn"));
    expect(replayed.events).toEqual(PAIR);
    expect(replayed.paused).toEqual([0]);
    expect(screen.getByTestId("kept-preview")).toHaveTextContent("Built on sketch/req-41-abcdef, 2 files changed.");
    expect(screen.getByTestId("kept-preview")).toHaveTextContent(SHA.slice(0, 9));
  });

  it("reopens live from the stored head: one POST naming the kept preview, then the idea beside the picture", async () => {
    const calls = core({
      [`POST /projects/${PROJECT}/previews`]: () => ({ status: 201, body: { preview: idea({ id: "9df98619-9f7c-46b8-8e65-a67f2fcdce74", state: "starting", liveAt: null }) } }),
      "GET /previews/9df98619-9f7c-46b8-8e65-a67f2fcdce74": () => ({ body: { preview: idea({ id: "9df98619-9f7c-46b8-8e65-a67f2fcdce74", state: "starting", liveAt: null }) } }),
    });
    renderWithQuery(<KeptPreviewPicture content={content as never} alt="The home with a larger chat box" projectId={PROJECT} reqKey="REQ-41" slug="hop" canWrite />);
    fireEvent.click(screen.getByRole("button", { name: "Reopen live" }));
    await screen.findByTestId("idea-panel");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      kind: "idea",
      about: "REQ-41",
      brief: "Continue from the kept preview: The home with a larger chat box",
      from: PREVIEW_ID,
    });
    expect(PREVIEW_ROUTES.ofProject).toBe("/api/projects/:id/previews");
  });

  it("says when the still could not be drawn, rather than leaving an empty frame", async () => {
    const orig = replayed.paused;
    vi.resetModules();
    vi.doMock("rrweb", () => ({
      Replayer: class {
        constructor() {
          throw new Error("bad snapshot");
        }
      },
    }));
    const { KeptPreviewPicture: Fresh } = await import("./idea-kept-picture");
    renderWithQuery(<Fresh content={content as never} alt="x" projectId={PROJECT} reqKey="REQ-41" slug="hop" canWrite />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The kept page could not be drawn here.");
    expect(orig).toEqual([]);
    vi.doUnmock("rrweb");
  });
});
