import { FAILURE_CAUSES } from "@forge/contracts/failure-causes";
import { describe, expect, it } from "vitest";
import strings from "@/lib/i18n/product-copy.json";
import { productCopy } from "@/lib/i18n/product-copy";
import { composerRefusal, personAdditionClaims, removalClaim, roomOpeningClaims } from "./membership";

const hop = { id: "a", name: "Hop", slug: "hop" };
const kho = { id: "b", name: "Kho", slug: "kho" };
const ENGLISH = /\b(room|agent will|anybody|nobody|will be|take|message|exactly|about)\b/i;

describe("membership claims", () => {
  it("read in English exactly as they were written", () => {
    const c = roomOpeningClaims({ projects: [hop, kho], agentCount: 2 });
    expect(c.map((x) => x.text)).toEqual([
      "This room will be about Hop and Kho. That is read from the agents in it, and nobody chooses it.",
      "A room about more than one project takes no messages from Forge — a message is answered under exactly one project. Take an agent out afterwards, and the room can be spoken in.",
      "With more than one agent this is a shared room: anybody holding a role on Hop and Kho will be able to read it, not only the people listed here.",
    ]);
    expect(composerRefusal({ scopeProjects: [hop, kho] })).toEqual({
      reason: "This room is about Hop and Kho, and a message is answered under exactly one project.",
      wayOut: "Take one of its agents out, and the room can be spoken in again.",
    });
    expect(personAdditionClaims({ name: "Lan", room: { shape: "direct" } })[0]?.text).toBe(
      "Lan will be able to read this room, including everything said in it before now.",
    );
  });

  it("read with no English sentence in Vietnamese", () => {
    const t = productCopy("vi");
    const texts = [
      ...roomOpeningClaims({ projects: [hop, kho], agentCount: 2, t }).map((x) => x.text),
      ...roomOpeningClaims({ projects: [hop], agentCount: 1, t }).map((x) => x.text),
      ...personAdditionClaims({ name: "Lan", room: { shape: "group", scopeProjects: [hop] }, t }).map((x) => x.text),
      removalClaim({ id: "p", kind: "person", displayName: null } as never, {}, t),
      composerRefusal({ scopeProjects: [hop, kho] }, t)?.reason ?? "",
    ];
    for (const s of texts) expect(s, s).not.toMatch(ENGLISH);
  });
});

describe("the locale file", () => {
  it("holds every key in both languages", () => {
    const en = Object.keys(strings.en);
    const vi = Object.keys(strings.vi);
    expect(en.filter((k) => !(k in strings.vi))).toEqual([]);
    expect(vi.filter((k) => !(k in strings.en))).toEqual([]);
  });

  it("has a reason word in both languages for every failure cause", () => {
    for (const cause of FAILURE_CAUSES) {
      for (const lang of ["en", "vi"] as const) {
        const map = strings[lang] as Record<string, string>;
        expect(map[`sessions.reason.${cause}`], `${lang} sessions.reason.${cause}`).toBeTruthy();
      }
    }
  });
});
