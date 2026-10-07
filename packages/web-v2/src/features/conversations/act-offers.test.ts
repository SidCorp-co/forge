// The buttons the assistant offers in a thread: read from the turn's own `offer_act` results, and
// pressed through the route the issue page uses for the same act (chat mining 2026-10-07: 30 asks to
// run, continue or close an issue met 38 replies saying chat cannot).

import { beforeEach, describe, expect, it, vi } from "vitest";

const called: string[] = [];
vi.mock("@/features/issues/api", () => ({
  issuesApi: {
    transition: async (id: string, to: string, opts?: { reason?: string }) => {
      called.push(`transition ${id} ${to}${opts?.reason ? ` (${opts.reason})` : ""}`);
    },
    runPipelineStep: async (id: string) => {
      called.push(`run-step ${id}`);
    },
  },
  releaseBatchApi: {
    create: async (projectId: string, ids: string[]) => {
      called.push(`release ${projectId} ${ids.join(",")}`);
    },
  },
}));

const { actOffersOf, pressAct } = await import("./act-offers");

const PROJECT = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
const ISSUE = "a37ef0fd-13e6-4a48-9b6b-76127dc386fc";
const offer = (over: Record<string, unknown>) => ({
  v: 1,
  act: "drop",
  effect: "transition",
  projectId: PROJECT,
  issueId: ISSUE,
  key: "ISS-744",
  title: "Old export",
  from: "open",
  to: "dropped",
  reason: "hiện tại không cần nữa", // i18n-allow: a production ask or reply replayed as the test case
  ...over,
});
const block = (output: unknown, over: Record<string, unknown> = {}) => ({
  type: "tool" as const,
  toolCall: {
    id: "call-1",
    name: "offer_act",
    output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(output) }] }),
    ...over,
  },
});

beforeEach(() => {
  called.length = 0;
});

describe("an offer in a turn is drawn as a button", () => {
  it("reads the offer a turn's offer_act result carries", () => {
    const offers = actOffersOf([{ type: "text", text: "Bấm để bỏ ISS-744." }, block({ offer: offer({}) })]); // i18n-allow: a production ask or reply replayed as the test case
    expect(offers).toHaveLength(1);
    expect(offers[0]?.key).toBe("ISS-744");
  });

  it("draws nothing for a refused call, a call still running, another tool or a malformed offer", () => {
    expect(actOffersOf([block({ offer: offer({}) }, { isError: true })])).toEqual([]);
    expect(actOffersOf([block(null, { output: undefined })])).toEqual([]);
    expect(actOffersOf([block({ offer: offer({}) }, { name: "forge" })])).toEqual([]);
    expect(actOffersOf([block({ offer: offer({ act: "close" }) })])).toEqual([]);
  });
});

describe("pressing it calls the issue page's own route", () => {
  it("drops with the reason, admits a draft, runs a step and releases", async () => {
    await pressAct(offer({}) as never);
    await pressAct(offer({ act: "run", effect: "admit", from: "draft", to: "open", reason: undefined }) as never);
    await pressAct(offer({ act: "run", effect: "run-step", to: undefined, reason: undefined }) as never);
    await pressAct(offer({ act: "release", effect: "release", from: "awaiting_release", to: undefined }) as never);
    expect(called).toEqual([
      `transition ${ISSUE} dropped (hiện tại không cần nữa)`, // i18n-allow: a production ask or reply replayed as the test case
      `transition ${ISSUE} open`,
      `run-step ${ISSUE}`,
      `release ${PROJECT} ${ISSUE}`,
    ]);
  });

  it("refuses a transition offer that names no status rather than guessing one", () => {
    expect(() => pressAct(offer({ to: undefined }) as never)).toThrow(/names no status/);
  });
});
