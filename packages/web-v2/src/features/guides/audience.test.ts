import { describe, expect, it } from "vitest";
import { AUDIENCES, BUNDLED_AUDIENCES, openDoors, searchLabel, siteCaption } from "./audience";
import { HELP_ONLY_SEARCH, LANDING_WHILE_DOWN } from "./missing";

const PEOPLE_ONLY = "For people using Forge and people connecting an assistant.";

describe("what the docs say they cover, from the doors on offer", () => {
  it("offers every door while the guide index answers, and the bundled doors alone while it does not", () => {
    expect(openDoors(false)).toEqual(AUDIENCES);
    expect(openDoors(true)).toEqual(BUNDLED_AUDIENCES);
  });

  it("names every reader under the site name while every door opens", () => {
    expect(siteCaption(openDoors(false))).toBe("For people using Forge, people connecting an assistant, and agents.");
  });

  it("names only the readers whose pages open while the index is down", () => {
    expect(siteCaption(openDoors(true))).toBe(PEOPLE_ONLY);
  });

  it("names one reader alone with no list around it", () => {
    expect(siteCaption(["agent"])).toBe("For agents.");
  });

  it("searches every page while every door opens, and says whose pages while some do not", () => {
    expect(searchLabel(openDoors(false))).toBe("Search every page");
    expect(searchLabel(openDoors(true))).toBe("Search the pages for people");
  });

  it("says the outage in the same words the search and the header use", () => {
    expect(HELP_ONLY_SEARCH).toBe("Search covers the pages for people only: the pages for agents could not be loaded.");
    expect(LANDING_WHILE_DOWN).toMatch(/^Forge's guide index did not answer, so the pages for agents could not be loaded\./);
  });
});
