import { describe, expect, it } from "vitest";
import { ecosystemRoutes } from "./routes";

describe("the route builders", () => {
  it("builds the ecosystem, the inbox and the create form at the workspace", () => {
    expect(ecosystemRoutes.list()).toBe("/ecosystems");
    expect(ecosystemRoutes.create()).toBe("/ecosystems/new");
    expect(ecosystemRoutes.ecosystem("e1")).toBe("/ecosystems/e1");
    expect(ecosystemRoutes.threads()).toBe("/ecosystems/threads");
    expect(ecosystemRoutes.threads({ view: "needs-me" })).toBe("/ecosystems/threads");
    expect(ecosystemRoutes.threads({ view: "held", ecosystem: "e1" })).toBe("/ecosystems/threads?view=held&ecosystem=e1");
  });

  it("keeps a project's own documents, contracts and API page under the project", () => {
    expect(ecosystemRoutes.document("forge", "FP-CN-1")).toBe("/projects/forge/ecosystem/channel/FP-CN-1");
    expect(ecosystemRoutes.compose("forge", { inReplyTo: "FP-CN-1" })).toBe(
      "/projects/forge/ecosystem/channel/new?inReplyTo=FP-CN-1",
    );
    expect(ecosystemRoutes.contracts("forge")).toBe("/projects/forge/ecosystem/contracts");
    expect(ecosystemRoutes.contract("forge-plugin", "forge-api", "p1")).toBe(
      "/projects/forge-plugin/ecosystem/contracts/forge-api?provider=p1",
    );
    expect(ecosystemRoutes.apiPage("forge")).toBe("/projects/forge/ecosystem/api");
  });
});
