// The stranded-App banner is read off a URL anybody can type: the cause only ever selects a sentence,
// and the only link it builds goes to github.com, whatever the query says the App is called.

import { describe, expect, it } from "vitest";
import { strandOf, strandedAppLink } from "./github-stranded-banner";

const q = (s: string) => new URLSearchParams(s);

describe("the stranded-App banner's reading of its query", () => {
  it("takes only a cause core sends", () => {
    expect(strandOf(q("connect=not_admin"))).toBe("not_admin");
    expect(strandOf(q("connect=<script>"))).toBeNull();
    expect(strandOf(q(""))).toBeNull();
  });

  it("links a named App's own settings page, an org's under the org", () => {
    expect(strandedAppLink(q("app=forge-x"))).toEqual({ name: "forge-x", href: "https://github.com/settings/apps/forge-x" });
    expect(strandedAppLink(q("app=forge-x&appOwner=SidCorp-co&appOrg=1")).href).toBe(
      "https://github.com/organizations/SidCorp-co/settings/apps/forge-x",
    );
  });

  it("names no App and links GitHub's list when the query's name is not an App slug", () => {
    expect(strandedAppLink(q("app=../../evil.example/x"))).toEqual({ name: null, href: "https://github.com/settings/apps" });
    expect(strandedAppLink(q("app=forge-x&appOwner=a/b&appOrg=1")).href).toBe("https://github.com/settings/apps/forge-x");
  });
});
