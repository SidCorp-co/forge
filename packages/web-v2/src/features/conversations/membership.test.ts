import { FAILURE_CAUSES } from "@forge/contracts/failure-causes";
import { describe, expect, it } from "vitest";
import { PRODUCT_STRINGS as strings, productCopy } from "@/lib/i18n/product-copy";
import { composerRefusal, personAdditionClaims, removalClaim, roomOpeningClaims } from "./membership";

const hop = { id: "a", name: "Hop", slug: "hop" };
const kho = { id: "b", name: "Kho", slug: "kho" };
const ENGLISH = /\b(room|agent will|anybody|nobody|will be|take|message|exactly|about)\b/i;

describe("membership claims", () => {
  it("read in English exactly as they were written", () => {
    const c = roomOpeningClaims({ projects: [hop, kho], agentCount: 2 });
    expect(c.map((x) => x.text)).toEqual([
      "About Hop and Kho.",
      "More than one project: the room takes no messages.",
      "Shared: anyone with a role on Hop and Kho reads it.",
    ]);
    expect(composerRefusal({ scopeProjects: [hop, kho] })).toEqual({
      reason: "About Hop and Kho; a message needs exactly one project.",
      wayOut: "Take an agent out to speak here again.",
    });
    expect(personAdditionClaims({ name: "Lan", room: { shape: "direct" } })[0]?.text).toBe(
      "Lan reads this room, including what was said before.",
    );
  });

  // A claim rewritten under REQ-43 carries English only (ISS-403), so a vi page reads its English
  // rather than a translation of the longer sentence it replaced; one still translated reads vi.
  it("read in Vietnamese where a translation stands, and in their English where none does", () => {
    const t = productCopy("vi");
    expect(removalClaim({ id: "p", kind: "person", displayName: null } as never, {}, t)).not.toMatch(ENGLISH);
    expect(roomOpeningClaims({ projects: [hop], agentCount: 1, t }).map((x) => x.text)).toEqual([
      "About Hop.",
      "One-to-one: only the people in it read it.",
    ]);
  });
});

describe("the product copy", () => {
  it("has an English reason word for every failure cause, which a vi page reads where no vi word was written", () => {
    const en = strings.en as Record<string, string>;
    for (const cause of FAILURE_CAUSES) expect(en[`sessions.reason.${cause}`], `en sessions.reason.${cause}`).toBeTruthy();
  });
});
