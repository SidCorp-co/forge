import { FAILURE_CAUSES } from "@forge/contracts/failure-causes";
import { describe, expect, it } from "vitest";
import { PRODUCT_STRINGS as strings } from "@/lib/i18n/product-copy";
import { composerRefusal, personAdditionClaims, roomOpeningClaims } from "./membership";

const hop = { id: "a", name: "Hop", slug: "hop" };
const kho = { id: "b", name: "Kho", slug: "kho" };

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
});

describe("the product copy", () => {
  it("has an English reason word for every failure cause", () => {
    const en = strings.en;
    for (const cause of FAILURE_CAUSES) expect(en[`sessions.reason.${cause}`], `en sessions.reason.${cause}`).toBeTruthy();
  });
});
