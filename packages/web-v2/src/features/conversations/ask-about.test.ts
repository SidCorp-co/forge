import { describe, expect, it } from "vitest";
import { aboutDraft, chatAbout } from "./ask-about";

describe("Ask about this", () => {
  it("opens Chat in the object's project with the object named first in the message", () => {
    const href = chatAbout("forge-dev", "issue", "ISS-24");
    expect(href).toBe("/chat/forge-dev?about=issue%3AISS-24");
    const about = new URLSearchParams(href.split("?")[1]).get("about");
    expect(aboutDraft(about)).toBe("About issue ISS-24: ");
  });

  it.each([null, "", "issue:", "secret:ISS-1", "ISS-24"])("drafts nothing from %j", (about) => {
    expect(aboutDraft(about)).toBeUndefined();
  });
});
