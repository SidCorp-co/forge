// REQ-41 BC-14, BC-15, BC-16 as a person sees them: the assistant's offer is a button that opens the
// idea beside the chat; Keep takes the page's snapshot from the frame and sends it with the sentence
// that says what it shows; a kept picture is drawn still on the requirement and reopens live from its head.
// Core is stood in for over `fetch` with the contracts' own routes.

import { IDEA_OFFER_TOOL } from "@forge/contracts/idea-offer";
import { fireEvent, screen, } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { PROJECT } from "@/test/requirement-pictures";
import { HOST, PREVIEW_ID, previewOf, } from "@/features/previews/fixtures";

const asked = vi.hoisted(() => ({ calls: 0, answer: null as unknown }));
vi.mock("@/features/previews/idea-snapshot", async (orig) => {
  const real = await orig<typeof import("@/features/previews/idea-snapshot")>();
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

const { ideaOffersOf, IdeaOfferCard } = await import("./idea-offers");
const _SHA = "c".repeat(40);
const idea = (over = {}) =>
  previewOf({ subject: { kind: "idea", about: { kind: "requirement", key: "REQ-41" }, branch: "sketch/req-41-abcdef" }, issueId: null, ...over });
const PAIR = [
  { type: 4, timestamp: 1, data: { href: HOST, width: 800, height: 600 } },
  { type: 2, timestamp: 2, data: { node: { type: 0, childNodes: [] } } },
];
const OFFER = { v: 1 as const, projectId: PROJECT, about: "REQ-41", title: "Chat is the way in", brief: "A larger chat box" };
const block = (output: unknown, over: Record<string, unknown> = {}) => ({
  type: "tool" as const,
  toolCall: { id: "c1", name: IDEA_OFFER_TOOL, output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(output) }] }), ...over },
});
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

describe("the assistant's offer (BC-14)", () => {
  it("reads the offer a turn's offer_preview result carries, and none from a refused or foreign result", () => {
    expect(ideaOffersOf([{ type: "text", text: "Here." }, block({ offer: OFFER })])).toEqual([OFFER]);
    expect(ideaOffersOf([block({ offer: OFFER }, { isError: true })])).toEqual([]);
    expect(ideaOffersOf([block({ offer: { ...OFFER, about: "ISS-1" } })])).toEqual([]);
    expect(ideaOffersOf([block({ offer: OFFER }, { name: "offer_act" })])).toEqual([]);
  });

  it("reads the offer in the shape core's own assistant stores: the result body as plain JSON", () => {
    const stored = JSON.stringify({ offer: OFFER, note: "Shown to the person as a button in this conversation." });
    expect(ideaOffersOf([{ type: "tool", toolCall: { id: "c2", name: IDEA_OFFER_TOOL, output: stored } }])).toEqual([OFFER]);
  });

  it("opens nothing before the press, then posts the idea as the person and draws the idea beside the chat", async () => {
    const calls = core({
      [`POST /projects/${PROJECT}/previews`]: () => ({ status: 201, body: { preview: idea({ state: "starting", liveAt: null }) } }),
      [`GET /previews/${PREVIEW_ID}`]: () => ({ body: { preview: idea({ state: "starting", liveAt: null }) } }),
    });
    renderWithQuery(<IdeaOfferCard offer={OFFER} />);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Build the preview" }));
    await screen.findByTestId("idea-panel");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/projects/${PROJECT}/previews`);
    expect(post?.body).toEqual({ kind: "idea", about: "REQ-41", brief: "A larger chat box" });
    expect(screen.getByTestId("idea-panel")).toHaveAttribute("data-state", "starting");
  });

  it("names a refusal of core in its own words", async () => {
    core({ [`POST /projects/${PROJECT}/previews`]: () => ({ status: 503, body: refusal("PREVIEW_RUNNER_UNSUPPORTED", "no box bound to this project is online") }) });
    renderWithQuery(<IdeaOfferCard offer={OFFER} />);
    fireEvent.click(screen.getByRole("button", { name: "Build the preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no box bound to this project is online");
  });
});

